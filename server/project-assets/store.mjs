import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CREATIVE_TABLES, creativeSchema, creativeIndexes, migrateCreativeArchive } from './schema.mjs';
import { blankAsset, canonical, digest, fault, idOK, nameKey, normalize } from './model.mjs';
import {CharacterVoiceFiles} from './voices.mjs';
import {cardBinding,cropState,defaultCrop} from './crop-state.mjs';

const parse = value => JSON.parse(value);
const PUBLIC_KEY = 'creative-public';
const active = row => row.archived_at === null;
export class ProjectAssets {
  constructor(lib) { this.lib = lib; this.healthCache = new Map();this.voices=new CharacterVoiceFiles(lib); }
  get db() { return this.lib.db; }
  tx(fn) { const action = this.db.transaction(fn); return (action.immediate ?? action)(); }
  lock() { return this.db.kind === 'mysql' ? ' FOR UPDATE' : ''; }
  init() {
    for (const sql of creativeSchema(this.db.kind === 'mysql')) this.db.exec(sql);
    migrateCreativeArchive(this.lib);
    for (const [table, fields] of Object.entries(CREATIVE_TABLES)) {
      const columns = this.db.kind === 'mysql' ? this.db.prepare('SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?').all(table) : this.db.prepare(`PRAGMA table_info(${table})`).all();
      if (Object.keys(fields).some(name => !columns.some(c => c.name === name))) throw fault('资产库 schema 升级未完成，请恢复升级前备份后重试：' + table, 503);
    }
    for (const [name, [table, column]] of Object.entries(creativeIndexes)) {
      const exists = this.db.kind === 'mysql' ? this.db.prepare('SELECT INDEX_NAME name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?').get(table, name) : this.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(name);
      if (!exists) this.db.exec(`CREATE INDEX ${name} ON ${table}(${column})`);
    }
    const state = this.db.prepare('SELECT * FROM creative_schema WHERE id=?').get('asset-library');
    if (state && state.version !== 2) throw fault('资产库 schema 版本不受支持，未开放写入', 503);
    if (!state) { const now = Date.now(); this.db.prepare('INSERT INTO creative_schema VALUES(?,?,?,?)').run('asset-library', 2, now, now); }
    this.tx(() => {
      if (!this.db.prepare('SELECT id FROM media_projects WHERE system_key=?' + this.lock()).get(PUBLIC_KEY)) {
        const id = randomUUID(), now = Date.now();
        this.db.prepare('INSERT INTO media_projects(id,name,software,note,created_at,updated_at,project_kind,system_key) VALUES(?,?,?,?,?,?,?,?)').run(id, '@公共人物库-' + id.slice(0, 8), '', '系统公共人物库', now, now, 'public', PUBLIC_KEY);
      }
    });
    return this;
  }
  project(id, lock = false) {
    if (!idOK(id)) throw fault('项目编号无效');
    const row = this.db.prepare('SELECT * FROM media_projects WHERE id=?' + (lock ? this.lock() : '')).get(id);
    if (!row) throw fault('项目不存在或已删除', 404);
    return row;
  }
  scopes() { return { storage: this.db.kind === 'mysql' ? 'mysql' : 'sqlite', items: this.db.prepare('SELECT id,name,project_kind FROM media_projects ORDER BY created_at,id').all().map(p => ({ ...p, name: p.project_kind === 'public' ? '公共项目 · 人物库' : p.name })) }; }
  head(id, lock = false) {
    if (!idOK(id)) throw fault('资产编号无效');
    const row = this.db.prepare('SELECT * FROM creative_assets WHERE id=?' + (lock ? this.lock() : '')).get(id);
    if (!row) throw fault('资产不存在', 404);
    return row;
  }
  expected(row, revision) { if (!Number.isSafeInteger(revision) || row.revision !== revision) throw fault('角色已经更新，请核对最新版本；你的编辑仍保留', 409, { current_revision: row.revision }); }
  get(id) {
    const a = this.head(id), unpack = r => { const { data_json, source_json, ...rest } = r; return { ...rest, ...parse(data_json), source: parse(source_json) }; };
    const asset={ ...unpack(a), ...(this.storyboards ? {storyboard_protected: !!this.db.prepare('SELECT id FROM storyboard_asset_links WHERE asset_id=? LIMIT 1').get(id)} : {}), looks: this.db.prepare('SELECT * FROM creative_looks WHERE asset_id=? ORDER BY sort_order,id').all(id).map(unpack), images: this.db.prepare('SELECT * FROM creative_image_bindings WHERE asset_id=? ORDER BY sort_order,id').all(id).map(unpack) };
    if(asset.kind==='character'){
      const cover=cardBinding(asset);
      for(const b of asset.images){
        b.crop_source??=null;
        b.crop_manually_edited=b.crop_manually_edited===true||b.crop_source==='manual';
        b.was_card_default=b.was_card_default===true||b.id===cover;
      }
    }
    return asset;
  }
  associatedShots(id) { this.head(id); if(!this.storyboards)throw fault('分镜模块尚未就绪，请稍后重试',503); return this.storyboards.assetShots(id); }
  list(query) {
    this.project(query.project_id);
    const kind = query.kind ?? 'character'; if (!['character', 'scene', 'prop'].includes(kind)) throw fault('资产类型无效');
    const q = String(query.q ?? '').toLowerCase(), archived = query.archived === 'true';
    const rows = this.db.prepare(`SELECT * FROM creative_assets WHERE project_id=? AND kind=? AND archived_at${archived ? '>0' : '=0'} ORDER BY updated_at DESC,id`).all(query.project_id, kind);
    const filtered = rows.filter(a => (a.name + parse(a.data_json).base_info).toLowerCase().includes(q));
    const page = Math.max(1, Math.min(100000, Number(query.page) || 1)), size = 40;
    return { total: filtered.length, page, items: filtered.slice((page - 1) * size, page * size).map(a => { const all = this.get(a.id); const look = all.looks.find(l => l.id === all.default_look_id); const image = all.images.find(b => b.id === (all.kind === 'character' ? look?.default_image_id : all.default_image_id)); return { ...all, look_count: all.looks.filter(active).length, cover: image ?? null }; }) };
  }
  async inspect(mediaId, expected = null, force = false) {
    let a, root;
    try { a = this.lib.asset(mediaId); root = this.lib.db.prepare('SELECT * FROM roots WHERE id=?').get(a.root_id); }
    catch { return { state: 'missing', label: '引用失效：素材记录不存在' }; }
    const info = { name: a.name, media_asset_id: a.id, path: a.path };
    if (a.kind !== 'photo') return { ...info, state: 'invalid', label: '仅支持图片素材' };
    if (a.trashed) return { ...info, state: 'trashed', label: '素材已移入废纸篓' };
    if (!root || root.retired) return { ...info, state: 'retired', label: '素材目录已注销' };
    if (root.online === 0) return { ...info, state: 'offline', label: '素材目录离线' };
    let handle;
    try {
      try { await fs.access(root.path); } catch (e) { if (e.code === 'ENOENT') return { ...info, state: 'offline', label: '素材目录离线' }; throw e; }
      const real = await this.lib.checked(a.path, a.root_id);
      handle = await fs.open(real, 'r'); const before = await handle.stat();
      if (!before.isFile()) throw fault('图片不是普通文件');
      const key = [real, before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs].join('|');
      let hash = !force && this.healthCache.get(key);
      if (!hash) { const h = createHash('sha256'); for await (const chunk of handle.createReadStream({ autoClose: false })) h.update(chunk); hash = h.digest('hex'); }
      const after = await handle.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return { ...info, state: 'changed', label: '图片正在变化，请稍后重试' };
      if (this.healthCache.size > 2000) this.healthCache.clear(); this.healthCache.set(key, hash);
      return { ...info, sha256: hash, state: expected && hash !== expected ? 'changed' : 'available', label: expected && hash !== expected ? '引用失效：图片内容已变更' : '可用' };
    } catch (e) { return { ...info, state: e.code === 'ENOENT' ? 'missing' : e.code === 'EACCES' || e.code === 'EPERM' ? 'permission' : 'error', label: e.code === 'ENOENT' ? '引用失效：图片缺失' : e.code === 'EACCES' || e.code === 'EPERM' ? '无权访问图片' : '图片检查失败：' + e.message }; }
    finally { await handle?.close(); }
  }
  async health(id) { const asset = this.get(id); return { revision: asset.revision, images: await Promise.all(asset.images.map(async b => ({ id: b.id, ...(await this.inspect(b.media_asset_id, b.expected_sha256)) }))) }; }
  async prepare(input, previous) {
    const a = normalize(input);
    if (previous && (a.project_id !== previous.project_id || a.kind !== previous.kind)) throw fault('不能更改资产所属项目或类型');
    if (previous) {
      for (const key of ['looks', 'images']) for (const old of previous[key]) if (!a[key].some(r => r.id === old.id)) throw fault('请归档条目，不能直接移除已有记录');
    }
    await this.voices.prepare(a,previous);
    for (const b of a.images) {
      const old = previous?.images.find(v => v.id === b.id);
      if (old && old.look_id !== b.look_id) throw fault('图片不能直接跨造型移动，请新建绑定');
      if (!old || old.media_asset_id !== b.media_asset_id || b.accept_current === true) {
        const health = await this.inspect(b.media_asset_id, null, true);
        if (health.state !== 'available') throw fault('不能采用这张图片：' + health.label);
        b.expected_sha256 = health.sha256; b.last_known_name = health.name;
      } else { b.expected_sha256 = old.expected_sha256; b.last_known_name = old.last_known_name ?? ''; }
      delete b.accept_current;
    }
    return a;
  }
  async create(input) {
    const a = await this.prepare(blankAsset(input.project_id, input.kind, input.name), null);
    return this.tx(() => { this.project(a.project_id, true); return this.write(a, null, '创建资产'); });
  }
  async save(id, input, revision) {
    const old = this.get(id); this.expected(old, revision);
    const a = await this.prepare({ ...input, id }, old);
    const cover=cardBinding(a),before=cardBinding(old);
    if(this.headBox&&cover&&cover!==before){
      const binding=a.images.find(b=>b.id===cover),previous=old.images.find(b=>b.id===cover);
      const state=cropState(binding,previous);
      if(!previous?.was_card_default&&!state.crop_manually_edited&&state.crop_source==='untouched'&&defaultCrop(binding.crop)){
        // Optional suggestion. The same revision check and transaction still
        // guard the default change; a detector failure never blocks the save.
        const found=await this.headBox.detect(binding).catch(()=>null);
        if(found?.status==='found'){
          binding.crop=found.crop;binding.crop_source='auto';
        }
      }
    }
    return this.tx(() => { this.project(a.project_id, true); const current = this.get(id); this.expected(this.head(id, true), revision); return this.write(a, current, '保存资料'); });
  }
  write(a, previous, summary, source = previous?.source ?? null) {
    if(this.generationLocks)for(const owner of [...new Set([a.project_id,previous?.project_id].filter(Boolean))].sort()){this.project(owner,true);this.generationLocks.assertWritable(owner);}
    const p = this.project(a.project_id);
    if (p.project_kind === 'public' && a.kind !== 'character') throw fault('公共项目当前仅管理人物');
    a = normalize(a);
    if (previous && a.archived_at) {
      this.assertUnlinked(a.id);
      if (!previous.archived_at) { const max=this.db.prepare('SELECT MAX(archived_at) n FROM creative_assets WHERE project_id=? AND kind=? AND name_key=?').get(a.project_id,a.kind,nameKey(a.name)).n??0; a.archived_at=Math.max(Date.now(),max+1); }
    }
    const existingName = this.db.prepare('SELECT id FROM creative_assets WHERE project_id=? AND kind=? AND name_key=? AND archived_at=?').get(a.project_id, a.kind, nameKey(a.name), a.archived_at);
    if (existingName && existingName.id !== a.id) throw fault('该名称已存在，本项目不允许同名资产，请修改名称', 409);
    if(a.kind==='character'){
      const cover=cardBinding(a);
      for(const b of a.images){
        const old=previous?.images.find(r=>r.id===b.id);
        Object.assign(b,cropState(b,old,{copy:!previous&&summary==='复制人物'}));
        b.was_card_default=old?.was_card_default===true||b.id===cover;
      }
    }else{
      for(const b of a.images){delete b.crop_source;delete b.crop_manually_edited;delete b.was_card_default;}
    }
    const now = Math.max(Date.now(), (previous?.updated_at ?? 0) + 1), revision = (previous?.revision ?? 0) + 1;
    const data = canonical({ base_info: a.base_info, performance_info: a.performance_info, details: a.details });
    const args = [a.project_id, a.kind, a.name, nameKey(a.name), data, a.default_look_id, a.default_image_id, revision, a.archived_at, canonical(source)];
    try {
      if (previous) this.db.prepare('UPDATE creative_assets SET project_id=?,kind=?,name=?,name_key=?,data_json=?,default_look_id=?,default_image_id=?,revision=?,archived_at=?,source_json=?,updated_at=? WHERE id=?').run(...args, now, a.id);
      else this.db.prepare('INSERT INTO creative_assets(id,project_id,kind,name,name_key,data_json,default_look_id,default_image_id,revision,archived_at,source_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(a.id, ...args, now, now);
    } catch (e) { if (e.code === 'ER_DUP_ENTRY' || String(e.code).startsWith('SQLITE_CONSTRAINT_UNIQUE')) throw fault('本项目已有同名资产，请修改名称', 409); throw e; }
    const child = (table, row, values, oldRows) => {
      const old = oldRows?.find(r => r.id === row.id);
      const owner = this.db.prepare(`SELECT asset_id FROM ${table} WHERE id=?`).get(row.id);
      if (owner && (!old || owner.asset_id !== a.id)) throw fault('条目编号已属于其他资产', 409);
      const sourceValue = old?.source ?? row.source ?? null;
      const content = { ...values, source_json: canonical(sourceValue) };
      const changed = !old || Object.entries(content).some(([k, v]) => k === 'data_json' ? v !== canonical(table === 'creative_looks' ? { name: old.name, tags: old.tags, description: old.description } : this.imageData(old)) : k === 'source_json' ? v !== canonical(old.source) : v !== old[k]);
      const all = { ...content, revision: (old?.revision ?? 0) + (changed ? 1 : 0), updated_at: changed ? now : old.updated_at };
      const keys = Object.keys(all);
      if (old) this.db.prepare(`UPDATE ${table} SET ${keys.map(k => k + '=?').join(',')} WHERE id=? AND asset_id=?`).run(...keys.map(k => all[k]), row.id, a.id);
      else { const insert = { id: row.id, asset_id: a.id, ...all, created_at: now }; const cols = Object.keys(insert); this.db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES(${cols.map(() => '?')})`).run(...cols.map(k => insert[k])); }
    };
    a.looks.forEach(l => child('creative_looks', l, { data_json: canonical({ name: l.name, tags: l.tags, description: l.description }), default_image_id: l.default_image_id, sort_order: l.sort_order, archived_at: l.archived_at }, previous?.looks));
    a.images.forEach(b => child('creative_image_bindings', b, { look_id: b.look_id, media_asset_id: b.media_asset_id, expected_sha256: b.expected_sha256, data_json: canonical(this.imageData(b)), sort_order: b.sort_order, archived_at: b.archived_at }, previous?.images));
    const result = this.get(a.id);
    this.db.prepare('INSERT INTO creative_asset_versions(id,asset_id,version,snapshot,summary,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(), a.id, revision, canonical(result), summary, now, now);
    return result;
  }
  imageData(b) { return { reference_type: b.reference_type, purpose: b.purpose, locks: b.locks, ignores: b.ignores, confirmed: b.confirmed, crop: b.crop, ...(Object.hasOwn(b,'crop_source')?{crop_source:b.crop_source,crop_manually_edited:b.crop_manually_edited,was_card_default:b.was_card_default}:{}), last_known_name: b.last_known_name ?? '' }; }
  assertUnlinked(id) {
    const exists = this.db.kind === 'mysql' ? this.db.prepare("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='storyboard_asset_links'").get() : this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='storyboard_asset_links'").get();
    if (exists && this.db.prepare('SELECT id FROM storyboard_asset_links WHERE asset_id=? LIMIT 1').get(id)) throw fault('该资产属于当前分镜素材清单，不能删除或归档；请先用完整 JSON 重新初始化并移出清单', 409);
  }
  archive(id, archived, revision) { const owner=this.head(id).project_id; return this.tx(() => {
    this.project(owner, true);this.generationLocks?.assertWritable(owner); const old=this.get(id); this.expected(this.head(id, true), revision);
    if (archived) this.assertUnlinked(id);
    const a = structuredClone(old), max = this.db.prepare('SELECT MAX(archived_at) n FROM creative_assets WHERE project_id=? AND kind=? AND name_key=?').get(a.project_id, a.kind, nameKey(a.name)).n ?? 0;
    a.archived_at = archived ? Math.max(Date.now(), max + 1) : 0;
    return this.write(a, old, archived ? '归档资产' : '恢复资产');
  }); }
  versions(id) { this.head(id); return this.db.prepare('SELECT id,version,summary,created_at FROM creative_asset_versions WHERE asset_id=? ORDER BY version DESC').all(id); }
  version(id, version) { this.head(id); const row = this.db.prepare('SELECT snapshot FROM creative_asset_versions WHERE asset_id=? AND version=?').get(id, Number(version)); if (!row) throw fault('版本不存在', 404); return parse(row.snapshot); }
  copyPreview(id, projectId) {
    const a = this.get(id), p = this.project(projectId); if (a.kind !== 'character' || a.archived_at) throw fault('只可复制未归档人物');
    return { source: a, target_project: { id: p.id, name: p.project_kind === 'public' ? '公共项目' : p.name }, source_revision: a.revision, request_id: randomUUID() };
  }
  copy(id, input) {
    if (!idOK(input.request_id)) throw fault('复制请求编号无效');
    const requestHash = digest({ id, ...input });
    return this.tx(() => {
      const done = this.db.prepare('SELECT * FROM creative_asset_copy_records WHERE id=?' + this.lock()).get(input.request_id);
      if (done) { if (done.request_hash !== requestHash) throw fault('复制请求编号已用于其他内容', 409); return this.get(done.target_id); }
      this.project(input.project_id, true);
      const original = this.get(id); this.expected(this.head(id, true), input.source_revision);
      if (original.kind !== 'character' || original.archived_at) throw fault('只可复制未归档人物');
      const a = structuredClone(original), map = new Map();
      a.id = randomUUID(); a.project_id = input.project_id; a.name = input.name; a.base_info = input.base_info ?? original.base_info; a.performance_info = input.performance_info ?? original.performance_info;
      a.looks = a.looks.filter(active); const lookIds = new Set(a.looks.map(l => l.id)); a.images = a.images.filter(b => active(b) && lookIds.has(b.look_id));
      for (const row of [...a.looks, ...a.images]) { const prior = row.id; row.id = randomUUID(); map.set(prior, row.id); row.source = { id: prior, asset_id: id, revision: row.revision }; }
      a.default_look_id = map.get(a.default_look_id) ?? null;
      for (const l of a.looks) l.default_image_id = map.get(l.default_image_id) ?? null;
      for (const b of a.images) b.look_id = map.get(b.look_id);
      const sourceProject = this.project(original.project_id), source = { project_id: original.project_id, project_name: sourceProject.project_kind === 'public' ? '公共项目' : sourceProject.name, asset_id: original.id, asset_name: original.name, revision: original.revision, copied_at: Date.now() };
      const result = this.write(normalize(a), null, '复制人物', source), now = Date.now();
      this.db.prepare('INSERT INTO creative_asset_copy_records VALUES(?,?,?,?,?,?,?)').run(input.request_id, id, result.id, requestHash, canonical(source), now, now);
      return result;
    });
  }
  copyStatus(id) { if (!idOK(id)) throw fault('请求编号无效'); const r = this.db.prepare('SELECT target_id FROM creative_asset_copy_records WHERE id=?').get(id); return r ? { completed: true, asset: this.get(r.target_id) } : { completed: false }; }
  usage(mediaId) { return this.db.prepare('SELECT b.id,b.asset_id,b.look_id,a.name,a.project_id,a.archived_at FROM creative_image_bindings b JOIN creative_assets a ON a.id=b.asset_id WHERE b.media_asset_id=? ORDER BY a.name,b.sort_order').all(mediaId); }
  snapshot() { return Object.fromEntries(Object.keys(CREATIVE_TABLES).map(t => [t, this.db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()])); }
  backup() { return this.tx(() => this.backupInTransaction()); }
  // Internal caller already owns the one transaction; never start a nested one.
  backupInTransaction() {
    const tables = this.snapshot(), projects = this.db.prepare('SELECT id,name,software,note,created_at,updated_at,project_kind,system_key FROM media_projects ORDER BY id').all(); const data = { tables, projects, ...(this.scripts?{project_scripts:this.scripts.snapshot()}:{}) }; return { format: 'shiguang-creative-backup', schema_version: 2, ...data, checksum: digest(data) };
  }
  validateBackup(input) {
    if (!input || input.format !== 'shiguang-creative-backup' || ![1,2].includes(input.schema_version) || digest({ tables: input.tables, projects: input.projects, ...(Object.hasOwn(input,'project_scripts')?{project_scripts:input.project_scripts}:{}) }) !== input.checksum || canonical(Object.keys(input.tables ?? {}).sort()) !== canonical(Object.keys(CREATIVE_TABLES).sort()) || !Array.isArray(input.projects) || input.projects.length > 10000) throw fault('资产库备份格式或摘要无效');
    input = structuredClone(input);
    if(Object.hasOwn(input,'project_scripts')&&!this.scripts)throw fault('项目剧本模块尚未就绪，未恢复备份');
    if (input.tables.creative_schema?.length !== 1 || input.tables.creative_schema[0].version !== input.schema_version) throw fault('备份 schema 版本无效');
    if (input.schema_version === 1) {
      for (const a of input.tables.creative_assets) a.archived_at ??= 0;
      for (const s of input.tables.creative_schema) s.version = 2;
      input.schema_version = 2;
      input.checksum = digest({tables: input.tables, projects: input.projects,...(Object.hasOwn(input,'project_scripts')?{project_scripts:input.project_scripts}:{})});
    }
    const projectIds = new Set();
    for (const p of input.projects) {
      if (!idOK(p.id) || projectIds.has(p.id) || typeof p.name !== 'string' || !p.name || !['normal','public'].includes(p.project_kind) || (p.project_kind === 'public' ? p.system_key !== PUBLIC_KEY : p.system_key !== null)) throw fault('备份项目身份无效');
      projectIds.add(p.id);
    }
    if (input.projects.filter(p => p.project_kind === 'public').length !== 1) throw fault('备份公共项目身份无效');
    this.scripts?.validateRows(Object.hasOwn(input,'project_scripts')?input.project_scripts:[],input.projects);
    for (const [table, columns] of Object.entries(CREATIVE_TABLES)) {
      const rows = input.tables[table], ids = new Set(); if (!Array.isArray(rows) || rows.length > 100000) throw fault('备份表数量无效');
      for (const row of rows) {
        if (!row || canonical(Object.keys(row).sort()) !== canonical(Object.keys(columns).sort()) || ids.has(row.id)) throw fault('备份记录结构或编号无效'); ids.add(row.id);
        for (const [key, type] of Object.entries(columns)) {
          const v = row[key];
          if ((type === 'id' || type === 'ref') && !idOK(v) || type === 'optional_ref' && v !== null && !idOK(v) || (type === 'integer' || type === 'nullable' && v !== null) && (!Number.isSafeInteger(v) || v < 0) || ['key','name','text'].includes(type) && typeof v !== 'string') throw fault('备份字段类型无效');
        }
        if (row.updated_at < row.created_at || row.revision !== undefined && row.revision < 1) throw fault('备份时间或修订号无效');
        for (const k of ['data_json','source_json','snapshot']) if (k in row) { try { parse(row[k]); } catch { throw fault('备份 JSON 字段无效'); } }
      }
    }
    const t = input.tables;
    if (t.creative_schema.length !== 1 || t.creative_schema[0].id !== 'asset-library' || t.creative_schema[0].version !== 2) throw fault('备份 schema 版本无效');
    const assets = new Map(t.creative_assets.map(a => [a.id, a]));
    const looks = new Map(t.creative_looks.map(l => [l.id,l]));
    for (const a of assets.values()) if (!projectIds.has(a.project_id)) throw fault('备份资产项目不存在');
    for (const l of looks.values()) if (assets.get(l.asset_id)?.kind !== 'character') throw fault('备份造型归属无效');
    for (const b of t.creative_image_bindings) if (!assets.has(b.asset_id) || b.look_id !== null && looks.get(b.look_id)?.asset_id !== b.asset_id || !/^[a-f0-9]{64}$/.test(b.expected_sha256)) throw fault('备份图片归属或摘要无效');
    const versionKeys = new Set();
    for (const v of t.creative_asset_versions) {
      const a = assets.get(v.asset_id), s = parse(v.snapshot), key = v.asset_id + '/' + v.version;
      if (!a || versionKeys.has(key) || v.version < 1 || v.version > a.revision || s.id !== a.id || s.project_id !== a.project_id || s.revision !== v.version || v.created_at !== v.updated_at) throw fault('备份版本引用无效');
      normalize(s); versionKeys.add(key);
    }
    for (const a of assets.values()) if (!versionKeys.has(a.id + '/' + a.revision)) throw fault('备份缺少当前版本');
    for (const c of t.creative_asset_copy_records) if (!assets.has(c.target_id) || !/^[a-f0-9]{64}$/.test(c.request_hash)) throw fault('备份复制记录无效');
    return input;
  }
  async restore(input) {
    input = this.validateBackup(input);
    const backup = this.backup(); const dir = path.join(this.lib.dataDir, 'backups'); await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, `creative-before-restore-${Date.now()}-${randomUUID()}.json`), JSON.stringify(backup), { flag: 'wx', mode: 0o600 });
    return this.tx(() => this.restoreRows(input, backup));
  }
  // Caller holds the transaction when restoring a combined storyboard backup.
  lockRestoreScope() {
    const ids=this.db.prepare('SELECT id FROM media_projects ORDER BY id'+this.lock()).all().map(row=>row.id);
    this.generationLocks?.assertRestoreProjects(ids);
  }
  restoreRows(input, backup) {
      this.lockRestoreScope();
      const current=this.backupInTransaction();
      if (backup && current.checksum !== backup.checksum) throw fault('备份期间资产库已变化，请重新恢复', 409);
      const incomingPublic = input.projects.find(p => p.system_key === PUBLIC_KEY), currentPublic = this.db.prepare('SELECT id FROM media_projects WHERE system_key=?').get(PUBLIC_KEY);
      if (incomingPublic && currentPublic && incomingPublic.id !== currentPublic.id) {
        if (this.db.prepare('SELECT id FROM creative_assets WHERE project_id=?').get(currentPublic.id)) throw fault('目标公共项目已有资产，未覆盖', 409);
        this.db.prepare('DELETE FROM media_projects WHERE id=?').run(currentPublic.id);
      }
      for (const p of input.projects) {
        const keys = ['id','name','software','note','created_at','updated_at','project_kind','system_key'];
        if (!idOK(p.id) || !['normal', 'public'].includes(p.project_kind) || !p.name || p.project_kind === 'public' && p.system_key !== PUBLIC_KEY) throw fault('备份项目无效');
        const old = this.db.prepare('SELECT ' + keys.join(',') + ' FROM media_projects WHERE id=?').get(p.id);
        if (old) { if (canonical(old) !== canonical(p)) throw fault('目标项目存在不同内容，未覆盖', 409); }
        else this.db.prepare(`INSERT INTO media_projects(${keys.join(',')}) VALUES(${keys.map(() => '?')})`).run(...keys.map(k => p[k]));
      }
      for (const [table, columns] of Object.entries(CREATIVE_TABLES)) {
        const rows = input.tables[table], keys = Object.keys(columns); if (!Array.isArray(rows) || rows.length > 100000) throw fault('备份表数量无效');
        for (const row of rows) {
          if (canonical(Object.keys(row).sort()) !== canonical(keys.sort())) throw fault('备份记录字段无效');
          const old = this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(row.id);
          if (old) {
            if (table === 'creative_schema' && old.version === row.version) this.db.prepare('UPDATE creative_schema SET created_at=?,updated_at=? WHERE id=?').run(row.created_at, row.updated_at, row.id);
            else if (canonical(old) !== canonical(row)) throw fault('同编号数据存在差异，未覆盖', 409);
          }
          else this.db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?')})`).run(...keys.map(k => row[k]));
        }
      }
      for (const row of input.tables.creative_assets) { const a = this.get(row.id); this.project(a.project_id); normalize(a); }
      for (const table of ['creative_looks', 'creative_image_bindings', 'creative_asset_versions']) for (const r of input.tables[table]) this.head(r.asset_id);
      this.scripts?.restoreRows(Object.hasOwn(input,'project_scripts')?input.project_scripts:[]);
      return { restored: true, assets: input.tables.creative_assets.length };
  }
}
