import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical,compile,definition,fault} from '../prompt-templates/model.mjs';
import {PROMPT_TABLES} from '../prompt-templates/schema.mjs';
import {CODEX_TABLES} from './schema.mjs';
import {ACTIVE,STATUSES,turnRequest} from './store.mjs';
import {sha256,validId,decodeImage,imageFormat} from './media.mjs';

const digest=value=>sha256(Buffer.from(canonical(value)));
const parse=value=>{try{return JSON.parse(value);}catch{throw fault('备份 JSON 无效');}};
const LIMIT=50*1024*1024;
export class CodexBackup {
  constructor(store,media,service){this.store=store;this.prompts=store.prompts;this.media=media;this.service=service;}
  available(){if(this.service.tasks.size)throw fault('请先停止生成，再备份或恢复',409);}
  snapshot(){return this.store.tx(()=>({templates:this.prompts.snapshot(),tables:this.store.snapshot()}));}
  async backup(){
    this.available();const snapshot=this.snapshot(),images=[];let size=0;
    for(const row of snapshot.tables.codex_attachments){const bytes=await this.media.read(row);size+=bytes.length;if(size>LIMIT)throw fault('图片总量超过 50 MB，请分批导出对话图片');images.push({id:row.id,data:bytes.toString('base64')});}
    this.available();if(digest(this.snapshot())!==digest(snapshot))throw fault('备份期间数据发生变化，请重试',409);
    const templates={format:'shiguang-prompt-backup',schema_version:2,exported_at:new Date().toISOString(),checksum:digest(snapshot.templates),tables:snapshot.templates};
    const payload={templates,tables:snapshot.tables,images};
    return{format:'shiguang-codex-workspace',schema_version:2,exported_at:new Date().toISOString(),...payload,checksum:digest(payload)};
  }
  validate(input){
    if(!input||input.format!=='shiguang-codex-workspace'||input.schema_version!==2||!input.tables||!Array.isArray(input.images)||input.checksum!==digest({templates:input.templates,tables:input.tables,images:input.images}))throw fault('图文备份格式或校验摘要无效');
    const templateTables=this.prompts.validateBackup(input.templates);
    if(canonical(Object.keys(input.tables).sort())!==canonical(Object.keys(CODEX_TABLES).sort()))throw fault('对话备份表清单无效');
    for(const [table,columns]of Object.entries(CODEX_TABLES)){
      const rows=input.tables[table];if(!Array.isArray(rows)||rows.length>10000)throw fault('备份数据行数超出限制');const ids=new Set();
      for(const row of rows){if(!row||canonical(Object.keys(row).sort())!==canonical(Object.keys(columns).sort())||ids.has(row.id))throw fault('备份记录结构或 ID 无效');ids.add(row.id);
        for(const [key,kind]of Object.entries(columns)){const value=row[key];if(['id','ref'].includes(kind)&&!validId(value))throw fault('备份引用 ID 无效');if((kind==='integer'||kind==='nullable'&&value!==null)&&(!Number.isSafeInteger(value)||value<1))throw fault('备份时间、版本或大小无效');if(['text','short','hash'].includes(kind)&&(typeof value!=='string'||kind==='short'&&value.length>100||kind==='hash'&&!/^[0-9a-f]{64}$/.test(value)))throw fault('备份字段无效');}
        if(row.updated_at<row.created_at)throw fault('备份时间顺序无效');
      }
    }
    const templates=new Map(input.templates.tables.prompt_templates.map(r=>[r.id,r])),heads=new Map(),turns=new Map(),sequences=new Map();
    for(const row of input.tables.codex_conversations){const context=parse(row.context_json);if(!templates.has(row.template_id)||context.template_id!==row.template_id||!Number.isSafeInteger(context.version)||context.version<1||row.title.length>200)throw fault('对话模板引用无效');const def=definition(context.definition),result=compile(def,context.values),version=input.templates.tables.prompt_template_versions.find(v=>v.template_id===row.template_id&&v.version===context.version);if(!version||canonical(parse(version.definition))!==canonical(def)||result.errors.length||result.prompt!==context.prompt||canonical(result.values)!==canonical(context.values))throw fault('对话模板快照无效');heads.set(row.id,row);}
    for(const row of input.tables.codex_turns){if(!heads.has(row.conversation_id)||!STATUSES.includes(row.status)||ACTIVE.includes(row.status))throw fault('对话任务引用或完成状态无效');const request=parse(row.request_json);if(canonical(turnRequest({id:row.id,...request}))!==canonical(request))throw fault('任务输入不规范');const actual=parse(row.actual_json),usage=parse(row.usage_json),blocks=parse(row.blocks_json);if(!actual||typeof actual!=='object'||Array.isArray(actual)||!usage||typeof usage!=='object'||Array.isArray(usage)||!Array.isArray(blocks)||blocks.length>1000)throw fault('回答内容无效');for(const block of blocks){if(!block||!['text','image'].includes(block.type)||typeof block.itemId!=='string'||block.type==='text'&&(typeof block.text!=='string'||block.text.length>2_000_000)||block.type==='image'&&!['ready','failed','processing'].includes(block.status))throw fault('回答内容块无效');}turns.set(row.id,{row,request,blocks});const keys=sequences.get(row.conversation_id)??[];keys.push(row.sequence_no);sequences.set(row.conversation_id,keys);}
    for(const keys of sequences.values())if(keys.sort((a,b)=>a-b).some((n,i)=>n!==i+1))throw fault('对话消息次序不完整');
    for(const {row,request}of turns.values())if(request.retry_of){const previous=turns.get(request.retry_of);if(!previous||previous.row.conversation_id!==row.conversation_id||previous.row.sequence_no>=row.sequence_no||previous.request.text!==request.text)throw fault('重新生成引用无效');}
    const attachments=new Map(input.tables.codex_attachments.map(r=>[r.id,r])),images=new Map();let size=0;
    if(input.images.length!==attachments.size||input.images.length>2000)throw fault('备份图片清单不完整');
    for(const item of input.images){if(!item||!validId(item.id)||images.has(item.id))throw fault('备份图片 ID 无效');const row=attachments.get(item.id),bytes=decodeImage(item.data);size+=bytes.length;if(size>LIMIT)throw fault('备份图片总量超出 50 MB');if(!row||!turns.has(row.turn_id)||row.bytes!==bytes.length||row.mime!==imageFormat(bytes).mime||row.sha256!==sha256(bytes))throw fault('备份图片校验或引用无效');this.media.file(row);images.set(item.id,bytes);}
    for(const {row,blocks}of turns.values())for(const block of blocks)if(block.type==='image'&&block.status==='ready'){const attachment=attachments.get(block.attachmentId);if(!attachment||attachment.turn_id!==row.id)throw fault('回答图片引用无效');}
    return{tables:input.tables,images,templates:templateTables};
  }
  plan(valid){
    let added=0,skipped=0;
    for(const [table,rows]of Object.entries({...valid.templates,...valid.tables}))for(const row of rows){const existing=this.store.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(row.id);if(existing){if(canonical(existing)!==canonical(row))throw fault('同 ID 数据与当前库不同，未覆盖。请在历史中回滚或导入副本。',409);skipped++;}else{
      if(table==='codex_turns'&&this.store.db.prepare('SELECT id FROM codex_turns WHERE conversation_id=? AND sequence_no=?').get(row.conversation_id,row.sequence_no))throw fault('对话消息次序冲突，未覆盖',409);
      added++;
    }}
    this.prompts.restorePlan(valid.templates);
    return{added,skipped,conversations:valid.tables.codex_conversations.length,turns:valid.tables.codex_turns.length,images:valid.images.size,templates:valid.templates.prompt_templates.length,versions:valid.templates.prompt_template_versions.length,records:valid.templates.prompt_generations.length,deleted:valid.templates.prompt_templates.filter(t=>t.deleted_at!==null).length};
  }
  preview(input){this.available();return this.plan(this.validate(input));}
  async restore(input){
    this.available();const valid=this.validate(input);this.plan(valid);const before=await this.backup();
    const dir=path.join(this.store.lib.dataDir,'backups');await fs.mkdir(dir,{recursive:true});const file=path.join(dir,'prompt-codex-before-restore-'+Date.now()+'-'+randomUUID()+'.json');await fs.writeFile(file,JSON.stringify(before),{flag:'wx',mode:0o600});
    const fingerprint=digest({templates:before.templates.tables,tables:before.tables}),installed=[];
    try{
      for(const row of valid.tables.codex_attachments)if(await this.media.install(row,valid.images.get(row.id)))installed.push(row);
      this.available();
      return this.store.tx(()=>{
        if(this.store.db.kind==='mysql'){this.store.db.prepare('SELECT id FROM prompt_templates ORDER BY id FOR UPDATE').all();this.store.db.prepare('SELECT id FROM codex_conversations ORDER BY id FOR UPDATE').all();}
        if(digest({templates:this.prompts.snapshot(),tables:this.store.snapshot()})!==fingerprint)throw fault('恢复期间数据发生变化，请重新预览',409);
        const result=this.plan(valid),all={...valid.templates,...valid.tables},schemas={...PROMPT_TABLES,...CODEX_TABLES};
        for(const [table,rows]of Object.entries(all))for(const row of rows)if(!this.store.db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(row.id)){const columns=Object.keys(schemas[table]);this.store.db.prepare(`INSERT INTO ${table}(${columns.map(k=>'`'+k+'`').join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(k=>row[k]));}
        return{...result,backup:file};
      });
    }catch(e){for(const row of installed)if(!this.store.db.prepare('SELECT id FROM codex_attachments WHERE id=?').get(row.id))await fs.unlink(this.media.file(row)).catch(()=>{});throw e;}
  }
}
