import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {PromptTemplates} from '../server/prompt-templates/store.mjs';
import {definition,compile,canonical} from '../server/prompt-templates/model.mjs';
import {fixture,inputs,lifecycle} from './helpers/prompt-lifecycle.mjs';

async function setup(t){const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'prompt-sqlite-'));const db=new Database(path.join(dataDir,'library.sqlite'));const store=new PromptTemplates({db,dataDir}).init();t.after(async()=>{db.close();await fs.rm(dataDir,{recursive:true,force:true});});return store;}
function resigned(backup,mutate){const b=structuredClone(backup);mutate(b.tables);b.checksum=createHash('sha256').update(canonical(b.tables)).digest('hex');return b;}

test('SQLite: timestamps, draft conflict, immutable versions, multiselect, idempotency, rollback and soft deletion',async t=>{lifecycle(await setup(t));});
test('Full backup: deleted templates/history/drafts/records roundtrip, pre-restore backup, duplicate import skips',async t=>{
 const source=await setup(t),{backup}=lifecycle(source),target=await setup(t);
 assert.equal(target.previewRestore(backup).deleted,1);const result=await target.restore(backup);
 assert.equal(result.added,6);assert.equal(result.skipped,0);assert.deepEqual(target.snapshot(),source.snapshot());
 const before=JSON.parse(await fs.readFile(result.backup,'utf8'));assert.equal(before.tables.prompt_templates.length,0);
 assert.equal((await target.restore(backup)).added,0);assert.equal(target.previewRestore(backup).skipped,6);
 assert.equal(target.backup().checksum,backup.checksum);
});
test('Backup rejects checksum, orphan, broken history, forged prompt, malformed JSON and enormous version without writes',async t=>{
 const source=await setup(t),{backup}=lifecycle(source),target=await setup(t);
 const badChecksum=structuredClone(backup);badChecksum.tables.prompt_templates[0].name='tamper';
 const cases=[badChecksum,
  resigned(backup,b=>b.prompt_generations[0].template_id=randomUUID()),
  resigned(backup,b=>b.prompt_template_versions.splice(0,1)),
  resigned(backup,b=>b.prompt_generations[0].prompt+=' forged'),
  resigned(backup,b=>b.prompt_template_drafts[0].input_values='{invalid'),
  resigned(backup,b=>{b.prompt_templates[0].current_version=Number.MAX_SAFE_INTEGER;b.prompt_templates[0].revision=Number.MAX_SAFE_INTEGER;}),
  resigned(backup,b=>b.prompt_template_versions[0].rollback_of=999),
  resigned(backup,b=>b.prompt_generations[0].updated_at++),
  resigned(backup,b=>b.prompt_generations[0].input_values=canonical({...inputs,unexpected:'discarded'})),
 ];
 for(const b of cases){assert.throws(()=>target.previewRestore(b),e=>e.status===400);await assert.rejects(target.restore(b),e=>e.status===400);}
 assert.equal(target.list().items.length,0);assert.deepEqual(await fs.readdir(target.dataDir),['library.sqlite']);
});
test('Restore refuses current-ID and natural version/draft-key conflicts before any mutation',async t=>{
 const store=await setup(t),{backup,id}=lifecycle(store);
 for(const table of ['prompt_template_versions','prompt_template_drafts']){const collision=resigned(backup,b=>b[table][0].id=randomUUID());assert.throws(()=>store.previewRestore(collision),e=>e.status===409);}
 store.setDeleted(id,false,6);const before=store.backup().checksum;
 await assert.rejects(store.restore(backup),e=>e.status===409);assert.equal(store.backup().checksum,before);
});
test('Restore transaction rolls back on failure and refuses changes made while writing safety backup',async t=>{
 const source=await setup(t),{backup}=lifecycle(source),target=await setup(t);
 target.db.exec("CREATE TRIGGER fail_prompt_record BEFORE INSERT ON prompt_generations BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END");
 await assert.rejects(target.restore(backup),/synthetic rollback/);assert.equal(target.snapshot().prompt_templates.length,0);
 target.db.exec('DROP TRIGGER fail_prompt_record');
 const pending=target.restore(backup);target.create(fixture());await assert.rejects(pending,e=>e.status===409);assert.equal(target.list().items.length,1);
});
test('Model validates input types, defaults, required fields and unsafe keys; all bundled examples compile',async t=>{
 const store=await setup(t);for(const e of store.examples())assert.doesNotThrow(()=>definition(e));
 assert.ok(compile(fixture(),{}).errors.length);assert.ok(compile(fixture(),{...inputs,风格:['温暖','温暖']}).errors.length);
 assert.ok(compile(fixture(),{...inputs,时长:'0'}).errors.length);
 assert.throws(()=>definition({...fixture(),body:'{{未配置}}'}),e=>e.status===400);
 assert.throws(()=>definition({...fixture(),fields:[{key:'__proto__',type:'text',default:'',required:false}]}),e=>e.status===400);
 const one=definition({name:'选择',body:'{{选项}}',fields:[{key:'选项',type:'select',required:true,options:['甲','乙'],default:'甲'}]});assert.equal(compile(one,{}).prompt,'甲');
});

test('Slash field names preserve selection, required checks, versions, records and backup restore',async t=>{
 const store=await setup(t),key='原作 / 素材',wideKey='原作／素材';
 const input={name:'斜杠字段',body:'依据：{{原作 / 素材}}\n\n补充：{{原作／素材}}',fields:[{key,type:'select',required:true,options:['原作','素材'],default:'原作'},{key:wideKey,type:'textarea',required:false,default:''}]};
 const created=store.create(input),values={[key]:'素材',[wideKey]:''};
 assert.equal(compile(created.definition,values).prompt,'依据：素材');
 assert.deepEqual(compile(created.definition,{[key]:''}).errors,['请填写'+key]);
 store.saveDraft(created.id,{template_revision:1,expected_revision:0,values});
 const record=store.generate(created.id,{id:randomUUID(),template_revision:1,values});
 assert.equal(record.prompt,'依据：素材');
 const edited=store.save(created.id,{...created.definition,fields:created.definition.fields.map(f=>({...f,required:false}))},1);
 assert.deepEqual(compile(edited.definition,{[key]:'',[wideKey]:''}).errors,[]);
 assert.equal(store.version(created.id,1).definition.fields[0].required,true);
 const target=await setup(t);await target.restore(store.backup());
 assert.deepEqual(target.get(created.id),store.get(created.id));
 assert.deepEqual(target.records(created.id).items[0],record);
});
test('Invalid field settings identify the field and cause without weakening reserved-key guards',()=>{
 const field={key:'题目',type:'text',required:true,default:''};
 const input={name:'字段校验',body:'{{题目}}',fields:[field]};
 for(const [fields,message]of [
  [[{...field,key:'非法@名称'}],/「非法@名称」名称无效/],
  [[{...field,key:'字'.repeat(41)}],/名称无效/],
  [[{...field,key:'   '}],/名称无效/],
  [[null],/第 1 个输入项名称无效/],
  [[field,field],/输入项名称重复：「题目」/],
  [[{...field,type:'invalid'}],/「题目」类型无效/],
  [[{...field,required:'true'}],/「题目」必填设置无效/],
  ...['__proto__','constructor','prototype'].map(key=>[[{...field,key}],/系统保留名称/]),
 ])assert.throws(()=>definition({...input,fields}),e=>e.status===400&&message.test(e.message));
});

test('Manual template order is transactional, rejects stale lists, survives edits, append and soft-delete restore',async t=>{
 const store=await setup(t),{orderLifecycle}=await import('./helpers/prompt-lifecycle.mjs');const result=orderLifecycle(store),target=await setup(t);await target.restore(result.backup);assert.deepEqual(target.list().items.map(r=>r.id),result.ids);assert.deepEqual(target.snapshot(),store.snapshot());
 const before=store.backup().checksum,ids=store.list().items.map(r=>r.id);store.db.exec("CREATE TRIGGER refuse_order BEFORE UPDATE OF sort_order ON prompt_templates WHEN NEW.sort_order=2 BEGIN SELECT RAISE(ABORT,'synthetic order rollback'); END");assert.throws(()=>store.reorder({ids:[...ids].reverse(),expected_ids:ids}),/synthetic order rollback/);assert.equal(store.backup().checksum,before);
});
test('Existing SQLite schema backs up before adding order; schema-1 backups remain accepted with null positions',async t=>{
 const store=await setup(t);store.create(fixture());store.db.exec('ALTER TABLE prompt_templates DROP COLUMN sort_order');const old=store.snapshot();store.init();const names=(await fs.readdir(path.join(store.dataDir,'backups'))).filter(n=>n.startsWith('prompt-templates-before-order-'));assert.equal(names.length,1);const legacy=JSON.parse(await fs.readFile(path.join(store.dataDir,'backups',names[0]),'utf8'));assert.equal(legacy.schema_version,1);assert.deepEqual(legacy.tables,old);assert.equal(store.list().items[0].sort_order,null);const target=await setup(t);await target.restore(legacy);assert.deepEqual(target.snapshot(),store.snapshot());store.init();assert.equal((await fs.readdir(path.join(store.dataDir,'backups'))).length,1);
 const invalid=resigned(target.backup(),b=>b.prompt_templates[0].sort_order=-1);assert.throws(()=>target.previewRestore(invalid),e=>e.status===400);
});
