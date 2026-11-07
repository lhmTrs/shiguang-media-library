import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {definition,compile,canonical,fault} from './model.mjs';
import {PROMPT_TABLES,promptSchema} from './schema.mjs';
import {examples} from './examples.mjs';
const digest=v=>createHash('sha256').update(canonical(v)).digest('hex');
const parse=raw=>JSON.parse(raw);
const backupJSON=raw=>{try{return JSON.parse(raw);}catch{throw fault('备份 JSON 内容无效');}};
const idOK=id=>typeof id==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);
export class PromptTemplates {
 constructor(lib,{dataDir=lib.dataDir}={}){this.lib=lib;this.dataDir=dataDir;}
 get db(){return this.lib.db;}
 init(){const mysql=this.db.kind==='mysql';for(const sql of promptSchema(mysql))this.db.exec(sql);
  const columns=mysql?this.db.prepare("SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='prompt_templates'").all():this.db.prepare('PRAGMA table_info(prompt_templates)').all();
  if(!columns.some(c=>c.name==='sort_order')){
   const tables=this.tx(()=>this.snapshot()),directory=path.join(this.dataDir,'backups');mkdirSync(directory,{recursive:true});writeFileSync(path.join(directory,'prompt-templates-before-order-'+Date.now()+'-'+randomUUID()+'.json'),JSON.stringify({format:'shiguang-prompt-backup',schema_version:1,exported_at:new Date().toISOString(),checksum:digest(tables),tables}),{flag:'wx',mode:0o600});
   this.db.exec('ALTER TABLE prompt_templates ADD COLUMN sort_order '+(mysql?'BIGINT':'INTEGER')+' NULL');
  }return this;
 }
 tx(fn){const action=this.db.transaction(fn);return (action.immediate??action)();}
 head(id,lock=false){if(!idOK(id))throw fault('模板 ID 无效');const row=this.db.prepare('SELECT * FROM prompt_templates WHERE id=?'+(lock&&this.db.kind==='mysql'?' FOR UPDATE':'')).get(id);if(!row)throw fault('模板不存在',404);return row;}
 expected(row,revision,allowDeleted=false){if(row.deleted_at!==null&&!allowDeleted)throw fault('模板已删除，请先恢复',409);if(!Number.isSafeInteger(revision)||row.revision!==revision)throw fault('模板已被更新，请刷新后核对；你的编辑仍保留',409);}
 version(id,version){this.head(id);const row=this.db.prepare('SELECT * FROM prompt_template_versions WHERE template_id=? AND version=?').get(id,version);if(!row)throw fault('模板版本不存在',404);return {...row,definition:parse(row.definition)};}
 get(id){const row=this.head(id);const saved=this.db.prepare('SELECT * FROM prompt_template_drafts WHERE template_id=?').get(id);return {...row,definition:this.version(id,row.current_version).definition,draft:saved?{...saved,values:parse(saved.input_values)}:null};}
 list({deleted=false,q=''}={}){const rows=this.db.prepare(`SELECT * FROM prompt_templates WHERE deleted_at IS ${deleted?'NOT ':''}NULL ORDER BY CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END,sort_order,updated_at DESC,id`).all();return{items:rows.filter(r=>(r.name+' '+r.description+' '+r.category).toLowerCase().includes(String(q).toLowerCase())),storage:this.db.kind==='mysql'?'mysql':'sqlite'};}
 reorder(input){
  const valid=ids=>Array.isArray(ids)&&ids.length<=10000&&ids.every(idOK)&&new Set(ids).size===ids.length;
  if(!input||!valid(input.ids)||!valid(input.expected_ids)||canonical([...input.ids].sort())!==canonical([...input.expected_ids].sort()))throw fault('模板排序清单无效');
  return this.tx(()=>{
   const rows=this.db.prepare('SELECT * FROM prompt_templates ORDER BY id'+(this.db.kind==='mysql'?' FOR UPDATE':'')).all();
   const ordered=rows.sort((a,b)=>(a.sort_order===null?1:0)-(b.sort_order===null?1:0)||(a.sort_order??0)-(b.sort_order??0)||b.updated_at-a.updated_at||(a.id<b.id?-1:a.id>b.id?1:0));
   const current=ordered.filter(r=>r.deleted_at===null).map(r=>r.id);
   if(canonical(current)!==canonical(input.expected_ids))throw fault('模板列表或顺序已在别处更新，请重新读取后再拖动',409);
   const byId=new Map(rows.map(r=>[r.id,r]));let index=0;const result=ordered.map(row=>row.deleted_at===null?byId.get(input.ids[index++]):row),now=Date.now();
   const update=this.db.prepare('UPDATE prompt_templates SET sort_order=?,updated_at=? WHERE id=?');result.forEach((row,i)=>{if(row.sort_order!==i+1)update.run(i+1,Math.max(now,row.updated_at+1),row.id)});
   return this.list();
  });
 }
 create(input){const value=definition(input),id=randomUUID(),now=Date.now();return this.tx(()=>{
  const existing=this.db.prepare('SELECT id,sort_order,updated_at FROM prompt_templates ORDER BY id'+(this.db.kind==='mysql'?' FOR UPDATE':'')).all();let order=null;
  if(existing.some(r=>r.sort_order!==null)){let last=Math.max(...existing.map(r=>r.sort_order??0));const pending=existing.filter(r=>r.sort_order===null).sort((a,b)=>b.updated_at-a.updated_at||(a.id<b.id?-1:1));for(const row of pending)this.db.prepare('UPDATE prompt_templates SET sort_order=?,updated_at=? WHERE id=?').run(++last,Math.max(now,row.updated_at+1),row.id);order=last+1;}
  this.db.prepare('INSERT INTO prompt_templates(id,name,description,category,current_version,revision,deleted_at,created_at,updated_at,sort_order) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,value.name,value.description,value.category,1,1,null,now,now,order);
  this.append(id,1,value,null,now);return this.get(id);
 });}
 append(id,version,value,rollbackOf,now){this.db.prepare('INSERT INTO prompt_template_versions(id,template_id,version,definition,rollback_of,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,version,canonical(value),rollbackOf,now,now);}
 save(id,input,expectedRevision,rollbackOf=null){const value=definition(input);return this.tx(()=>{
  const row=this.head(id,true);this.expected(row,expectedRevision);const now=Math.max(Date.now(),row.updated_at+1),version=row.current_version+1;
  this.append(id,version,value,rollbackOf,now);this.db.prepare('UPDATE prompt_templates SET name=?,description=?,category=?,current_version=?,revision=?,updated_at=? WHERE id=?').run(value.name,value.description,value.category,version,row.revision+1,now,id);return this.get(id);
 });}
 rollback(id,version,expectedRevision){const target=this.version(id,version);return this.save(id,target.definition,expectedRevision,version);}
 setDeleted(id,deleted,expectedRevision){return this.tx(()=>{const row=this.head(id,true);this.expected(row,expectedRevision,true);const now=Math.max(Date.now(),row.updated_at+1);this.db.prepare('UPDATE prompt_templates SET deleted_at=?,revision=?,updated_at=? WHERE id=?').run(deleted?now:null,row.revision+1,now,id);return this.get(id);});}
 versions(id){this.head(id);return this.db.prepare('SELECT * FROM prompt_template_versions WHERE template_id=? ORDER BY version DESC').all(id).map(r=>({...r,definition:parse(r.definition)}));}
 saveDraft(id,input){return this.tx(()=>{const row=this.head(id,true);this.expected(row,input.template_revision);const previous=this.db.prepare('SELECT * FROM prompt_template_drafts WHERE template_id=?').get(id);if((previous?.revision??0)!==input.expected_revision)throw fault('填写草稿已在别处更新，请先核对',409);const values=compile(this.version(id,row.current_version).definition,input.values).values,now=Math.max(Date.now(),(previous?.updated_at??0)+1);
  if(previous)this.db.prepare('UPDATE prompt_template_drafts SET input_values=?,version=?,revision=?,updated_at=? WHERE id=?').run(canonical(values),row.current_version,previous.revision+1,now,previous.id);
  else this.db.prepare('INSERT INTO prompt_template_drafts(id,template_id,version,revision,input_values,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,row.current_version,1,canonical(values),now,now);
  return this.get(id).draft;
 });}
 generate(id,input){if(!idOK(input.id))throw fault('生成记录 ID 无效');return this.tx(()=>{const row=this.head(id,true);const existing=this.db.prepare('SELECT * FROM prompt_generations WHERE id=?').get(input.id);
  if(existing){if(existing.template_id!==id||canonical(parse(existing.input_values))!==canonical(input.values))throw fault('生成记录 ID 已用于其他内容',409);return this.record(existing);}
  this.expected(row,input.template_revision);const def=this.version(id,row.current_version).definition,result=compile(def,input.values);if(result.errors.length)throw fault(result.errors.join('；'));const now=Date.now();
  this.db.prepare('INSERT INTO prompt_generations(id,template_id,version,template_snapshot,input_values,prompt,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(input.id,id,row.current_version,canonical(def),canonical(result.values),result.prompt,now,now);
  return this.record(this.db.prepare('SELECT * FROM prompt_generations WHERE id=?').get(input.id));
 });}
 record(row){return {...row,definition:parse(row.template_snapshot),values:parse(row.input_values)};}
 records(id,page=1){this.head(id);const offset=(Math.floor(Math.max(1,Math.min(100000,Number(page)||1)))-1)*20;return{total:this.db.prepare('SELECT COUNT(*) n FROM prompt_generations WHERE template_id=?').get(id).n,items:this.db.prepare(`SELECT * FROM prompt_generations WHERE template_id=? ORDER BY created_at DESC,id LIMIT 20 OFFSET ${offset}`).all(id).map(r=>this.record(r))};}
 examples(){return examples.map(t=>definition(t));}
 snapshot(){return Object.fromEntries(Object.keys(PROMPT_TABLES).map(table=>[table,this.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));}
 backup(){return this.tx(()=>{const tables=this.snapshot();return{format:'shiguang-prompt-backup',schema_version:2,exported_at:new Date().toISOString(),checksum:digest(tables),tables};});}
 validateBackup(input){
  if(!input||input.format!=='shiguang-prompt-backup'||![1,2].includes(input.schema_version)||!input.tables||input.checksum!==digest(input.tables))throw fault('备份格式或校验摘要无效');
  if(canonical(Object.keys(input.tables).sort())!==canonical(Object.keys(PROMPT_TABLES).sort()))throw fault('备份表清单无效');const tables=structuredClone(input.tables);
  if(input.schema_version===1&&Array.isArray(tables.prompt_templates))for(const row of tables.prompt_templates)if(row&&typeof row==='object'&&!Object.hasOwn(row,'sort_order'))row.sort_order=null;
  for(const [name,cols] of Object.entries(PROMPT_TABLES)){
   const rows=tables[name];if(!Array.isArray(rows)||rows.length>10000)throw fault('备份行数超出限制');const ids=new Set();
   for(const row of rows){if(!row||canonical(Object.keys(row).sort())!==canonical(Object.keys(cols).sort())||!idOK(row.id)||ids.has(row.id))throw fault('备份行结构或 ID 无效');ids.add(row.id);
    for(const [key,type] of Object.entries(cols)){const v=row[key];if((type==='id'||type==='ref')&&!idOK(v))throw fault('备份引用 ID 无效');if((type==='integer'||type==='nullable'&&v!==null)&&(!Number.isSafeInteger(v)||v<1))throw fault('备份版本或时间无效');if(['name','category','text'].includes(type)&&typeof v!=='string')throw fault('备份内容类型无效');}
    if(row.updated_at<row.created_at)throw fault('备份时间次序无效');
   }
  }
  const heads=new Map(tables.prompt_templates.map(r=>[r.id,r])),versions=new Map(),draftIds=new Set(),versionNumbers=new Map();
  for(const row of tables.prompt_template_versions){const key=row.template_id+'/'+row.version;if(!heads.has(row.template_id)||versions.has(key)||row.created_at!==row.updated_at)throw fault('备份版本引用无效');let def;try{def=definition(parse(row.definition));}catch{throw fault('备份模板正文无效');}if(canonical(def)!==canonical(parse(row.definition)))throw fault('备份模板定义不规范');versions.set(key,{row,def});const numbers=versionNumbers.get(row.template_id)??[];numbers.push(row.version);versionNumbers.set(row.template_id,numbers);}
  for(const row of tables.prompt_template_versions)if(row.rollback_of!==null&&(!versions.has(row.template_id+'/'+row.rollback_of)||row.rollback_of>=row.version))throw fault('备份回滚引用无效');
  for(const row of heads.values()){const current=versions.get(row.id+'/'+row.current_version);if(!current||['name','description','category'].some(k=>row[k]!==current.def[k])||row.revision<row.current_version)throw fault('备份当前版本无效');const numbers=versionNumbers.get(row.id).sort((a,b)=>a-b);if(numbers.length!==row.current_version||numbers.some((n,i)=>n!==i+1))throw fault('备份版本历史不完整');}
  for(const row of tables.prompt_template_drafts){if(draftIds.has(row.template_id))throw fault('备份草稿重复');draftIds.add(row.template_id);const v=versions.get(row.template_id+'/'+row.version);if(!v)throw fault('备份草稿引用无效');const values=backupJSON(row.input_values),compiled=compile(v.def,values);if(canonical(values)!==canonical(compiled.values))throw fault('备份草稿输入无效');}
  for(const row of tables.prompt_generations){const v=versions.get(row.template_id+'/'+row.version);if(!v||row.created_at!==row.updated_at||canonical(backupJSON(row.template_snapshot))!==canonical(v.def))throw fault('备份记录引用无效');const values=backupJSON(row.input_values),r=compile(v.def,values);if(r.errors.length||r.prompt!==row.prompt||canonical(values)!==canonical(r.values))throw fault('备份生成记录不一致');}
  return tables;
 }
 restorePlan(tables){let added=0,skipped=0;for(const [name,rows]of Object.entries(tables))for(const row of rows){const existing=this.db.prepare(`SELECT * FROM ${name} WHERE id=?`).get(row.id);if(existing){if(canonical(existing)!==canonical(row))throw fault('目标库已有不同内容的同 ID 数据，未覆盖。可改用单模板导入。',409);skipped++;}else{if(name==='prompt_template_versions'&&this.db.prepare('SELECT id FROM prompt_template_versions WHERE template_id=? AND version=?').get(row.template_id,row.version)||name==='prompt_template_drafts'&&this.db.prepare('SELECT id FROM prompt_template_drafts WHERE template_id=?').get(row.template_id))throw fault('目标库已有不同 ID 的相同版本或草稿，未覆盖',409);added++;}}return{added,skipped};}
 previewRestore(input){const tables=this.validateBackup(input);return{...this.restorePlan(tables),templates:tables.prompt_templates.length,versions:tables.prompt_template_versions.length,records:tables.prompt_generations.length,deleted:tables.prompt_templates.filter(r=>r.deleted_at!==null).length,checksum:input.checksum};}
 async restore(input){const tables=this.validateBackup(input);this.restorePlan(tables);const before=this.backup();const dir=path.join(this.dataDir,'backups');await fs.mkdir(dir,{recursive:true});const file=path.join(dir,'prompt-templates-before-restore-'+Date.now()+'-'+randomUUID()+'.json');await fs.writeFile(file,JSON.stringify(before,null,2),{flag:'wx',mode:0o600});return this.tx(()=>{
  if(this.db.kind==='mysql')this.db.prepare('SELECT id FROM prompt_templates ORDER BY id FOR UPDATE').all();
  if(digest(this.snapshot())!==before.checksum)throw fault('备份期间数据发生变化，请重新预览恢复',409);const result=this.restorePlan(tables);
  for(const [name,columns]of Object.entries(PROMPT_TABLES))for(const row of tables[name])if(!this.db.prepare(`SELECT id FROM ${name} WHERE id=?`).get(row.id)){const keys=Object.keys(columns);this.db.prepare(`INSERT INTO ${name} (${keys.map(k=>'`'+k+'`').join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));}
  return{...result,backup:file};
 });}
}
