import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {creativeFixture} from './helpers/creative-fixture.mjs';
import {syntheticSource} from './helpers/storyboard-fixture.mjs';
import {StoryboardDatabase} from '../server/storyboard/database.mjs';
import {HISTORY_TABLES} from '../server/storyboard/history-schema.mjs';
import {canonical,digest} from '../server/project-assets/model.mjs';
async function make(t){const f=await creativeFixture();t.after(f.close);return {...f,board:new StoryboardDatabase(f.lib,f.store).init()};}
const initialize=f=>f.board.initialize(f.a.id,{source:syntheticSource(),request_id:randomUUID(),expected_revision:f.board.head(f.a.id)?.revision??null});
const agent={author:'agent',reason_category:'shot_feel',reason_text:'只改第一镜动作，其它不动'};
function save(f,mutate,change=agent){const current=f.board.read(f.a.id),project=structuredClone(current.project);mutate(project);return f.board.save(f.a.id,{project,expected_revision:current.revision,request_id:randomUUID(),change});}
const rawCharacters=f=>JSON.parse(f.board.head(f.a.id).document_json).characters;
function dump(db){return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(({name})=>[name,db.prepare('SELECT * FROM "'+name+'"').all().map(canonical).sort()]);}

test('B1: legacy and history-bearing backups fail before any restore write when schema is absent, partial or unknown',async t=>{
 const source=await make(t);initialize(source);const modern=source.board.backup(),legacy=structuredClone(modern);delete legacy.change_history;legacy.checksum=digest({tables:legacy.tables,creative:legacy.creative});
 for(const backup of [legacy,modern])for(const mode of ['absent','partial','unknown']){
  const target=await make(t);target.projects.remove(target.a.id);target.projects.remove(target.b.id);
  if(mode==='absent')for(const table of Object.keys(HISTORY_TABLES).reverse())target.db.exec('DROP TABLE '+table);
  if(mode==='partial')target.db.exec('DROP TABLE storyboard_pending');
  if(mode==='unknown')target.db.exec('ALTER TABLE storyboard_pending ADD COLUMN unknown_future_field TEXT');
  // Use the same module instance with a previously validated schema cache.
  const before=dump(target.db),files=await fs.readdir(target.dir);const code=mode==='absent'?'STORYBOARD_HISTORY_MIGRATION_REQUIRED':'STORYBOARD_HISTORY_SCHEMA_UNSUPPORTED';
  await assert.rejects(target.board.restore(backup),e=>e.status===503&&e.code===code);
  assert.deepEqual(dump(target.db),before);assert.deepEqual(await fs.readdir(target.dir),files);assert.equal(target.db.prepare('SELECT COUNT(*) n FROM storyboard_documents').get().n,0);
 }
});

test('B2: action-only agent save after first import, reimport or restore has no hydrate-only character diff',async t=>{
 for(const stage of ['first-import','reimport','restore']){
  const f=await make(t);initialize(f);
  if(stage==='reimport')initialize(f);
  if(stage==='restore'){save(f,p=>{p.scenes[0].shots[0].action+=' 手动旧修改';},{author:'user'});f.board.restoreVersion(f.a.id,1,{expected_revision:2,request_id:randomUUID()});}
  const before=structuredClone(rawCharacters(f)),revision=f.board.head(f.a.id).revision;assert.ok(Object.hasOwn(f.board.read(f.a.id).project.characters[0],'asset_revision'));
  const saved=save(f,p=>{p.scenes[0].shots[0].action+=' 只有动作';});assert.equal(saved.pending_count,1);assert.equal(saved.pending_document_count,0);
  assert.deepEqual(rawCharacters(f),before);assert.deepEqual(f.board.history.version(f.a.id,saved.version).project.characters,before);
  assert.ok(!f.board.history.changes(f.a.id,1).items[0].changes.some(c=>c.field==='characters'));
  assert.ok(!f.board.history.diff(f.a.id,revision).changes.some(c=>c.field==='characters'));
  assert.deepEqual(f.board.history.pending(f.a.id).items.map(i=>({kind:i.target_kind,fields:i.fields})),[{kind:'shot',fields:['action']}]);
  const unchanged=f.board.save(f.a.id,{project:f.board.read(f.a.id).project,expected_revision:saved.version});assert.equal(unchanged.unchanged,true);assert.equal(unchanged.version,saved.version);
 }
});

test('B2: explicit character business changes remain in stored snapshots/log/pending and survive later action-only saves',async t=>{
 const f=await make(t);initialize(f);const changed=save(f,p=>{p.characters[0].description='真正修改的人物描述';p.characters[0].appearance='真正修改的人物造型';},{...agent,reason_text:'修改人物描述与造型'});
 assert.equal(changed.pending_document_count,1);assert.equal(changed.pending_count,0);const characters=structuredClone(rawCharacters(f));assert.equal(characters[0].description,'真正修改的人物描述');assert.equal(characters[0].appearance,'真正修改的人物造型');
 const event=f.board.history.changes(f.a.id,1).items[0];assert.ok(event.changes.some(c=>c.field==='characters'&&c.after[0].description==='真正修改的人物描述'));assert.deepEqual(f.board.history.version(f.a.id,changed.version).project.characters,characters);
 f.board.history.clear(f.a.id,{all:true,through_version:changed.version});const action=save(f,p=>{p.scenes[0].shots[0].action+=' 后续动作';});assert.equal(action.pending_document_count,0);assert.equal(action.pending_count,1);assert.deepEqual(rawCharacters(f),characters);
});

test('B2: fresh master-asset hydration is not blamed on an unrelated agent action',async t=>{
 const f=await make(t);initialize(f);const before=structuredClone(rawCharacters(f)),manifest=structuredClone(JSON.parse(f.board.head(f.a.id).document_json).asset_manifest),asset=f.store.get(f.board.read(f.a.id).project.characters[0].id);
 await f.store.save(asset.id,{...asset,name:'主档改名',base_info:'主档更新的外观',performance_info:'主档更新的特点'},asset.revision);
 const visible=f.board.read(f.a.id);assert.equal(visible.project.characters[0].appearance,'主档更新的外观');
 const saved=save(f,p=>{p.scenes[0].shots[0].action+=' 新动作';});assert.equal(saved.pending_document_count,0);assert.deepEqual(rawCharacters(f),before);assert.equal(f.board.read(f.a.id).project.characters[0].appearance,'主档更新的外观');assert.equal(f.board.read(f.a.id).project.characters[0].name,'主档改名');assert.deepEqual(JSON.parse(f.board.head(f.a.id).document_json).asset_manifest,manifest);
});
