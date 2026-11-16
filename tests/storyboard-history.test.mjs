import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {creativeFixture} from './helpers/creative-fixture.mjs';
import {syntheticSource} from './helpers/storyboard-fixture.mjs';
import {StoryboardDatabase} from '../server/storyboard/database.mjs';
import {storyboardDiff} from '../server/storyboard/shared/change-diff.mjs';
import {HISTORY_TABLES,installHistory} from '../server/storyboard/history-schema.mjs';
import {canonical,digest} from '../server/project-assets/model.mjs';
const init=(b,f)=>b.initialize(f.a.id,{source:syntheticSource(),request_id:randomUUID(),expected_revision:b.head(f.a.id)?.revision??null});
const edit=(b,f,fn=p=>{p.scenes[0].shots[0].action+=' 新动作';},extra={})=>{const current=b.read(f.a.id),project=structuredClone(current.project);fn(project);return b.save(f.a.id,{project,expected_revision:current.revision,request_id:randomUUID(),...extra});};
async function fixture(t){const f=await creativeFixture();t.after(f.close);return {...f,b:new StoryboardDatabase(f.lib,f.store).init()};}

test('all-or-nothing document/snapshot/changes/pending; no-op and exact request replay; stale revision',async t=>{
 const f=await fixture(t),b=f.b;const first=init(b,f);assert.equal(first.version,1);const original=b.backup().checksum;
 for(const table of ['storyboard_documents','storyboard_versions','storyboard_changes','storyboard_pending']){
  f.db.exec(`CREATE TRIGGER abort_history BEFORE ${table==='storyboard_documents'?'UPDATE':'INSERT'} ON ${table} BEGIN SELECT RAISE(ABORT,'owned history fault');END`);
  assert.throws(()=>edit(b,f),/owned history fault/);assert.equal(b.backup().checksum,original);f.db.exec('DROP TRIGGER abort_history');
 }
 const request={project:structuredClone(first.project),expected_revision:first.revision,request_id:randomUUID(),change:{author:'agent',reason_category:'shot_feel',reason_text:'把第一镜改成近景'}};request.project.scenes[0].shots[0].action='目光抬起';
 const saved=b.save(f.a.id,request);assert.equal(saved.revision,2);assert.equal(saved.saved_version,2);assert.equal(b.save(f.a.id,request).repeated,true);assert.equal(b.history.versions(f.a.id).total,2);
 assert.throws(()=>b.save(f.a.id,{...request,request_id:randomUUID()}),e=>e.status===409);
 assert.throws(()=>b.save(f.a.id,{...request,project:{...request.project,title:'different'}}),{code:'REQUEST_ID_CONFLICT'});
 const noChange=b.save(f.a.id,{project:b.read(f.a.id).project,expected_revision:2});assert.equal(noChange.unchanged,true);assert.equal(b.history.versions(f.a.id).total,2);
 const changes=b.history.changes(f.a.id);assert.equal(changes.items[0].reason_text,'把第一镜改成近景');assert.equal(changes.items[0].author_kind,'agent');
 assert.throws(()=>edit(b,f,undefined,{change:{author:'agent'}}),{code:'CHANGE_REASON_REQUIRED'});
});

test('existing schema migrates only explicitly; read GET never seeds baseline; first real save atomically adds baseline',async t=>{
 const f=await fixture(t),b=f.b;init(b,f);for(const table of Object.keys(HISTORY_TABLES).reverse())f.db.exec('DROP TABLE '+table);
 const existing=new StoryboardDatabase(f.lib,f.store).init();assert.equal(existing.read(f.a.id).history_available,false);assert.throws(()=>existing.history.versions(f.a.id),{code:'STORYBOARD_HISTORY_MIGRATION_REQUIRED'});
 assert.throws(()=>edit(existing,f),{code:'STORYBOARD_HISTORY_MIGRATION_REQUIRED'});installHistory(f.db);assert.equal(existing.history.versions(f.a.id).total,0);
 existing.save(f.a.id,{project:existing.read(f.a.id).project,expected_revision:1});assert.equal(existing.history.versions(f.a.id).total,0);
 f.db.exec("CREATE TRIGGER fail_baseline BEFORE INSERT ON storyboard_pending BEGIN SELECT RAISE(ABORT,'baseline rollback');END");assert.throws(()=>edit(existing,f),/baseline rollback/);assert.equal(existing.history.versions(f.a.id).total,0);f.db.exec('DROP TRIGGER fail_baseline');
 edit(existing,f);const versions=existing.history.versions(f.a.id).items;assert.equal(versions.length,2);assert.equal(versions[1].baseline,true);assert.equal(versions[1].author_kind,'baseline');
});

test('pending clear only touches actually observed versions, category CAS is separate and preserves raw reason',async t=>{
 const f=await fixture(t),b=f.b;init(b,f);b.history.clear(f.a.id,{all:true,through_version:1});
 const v2=edit(b,f,undefined,{change:{author:'agent',reason_category:'prompt_wrong',reason_text:'这句必须逐字保留'}});const old=b.history.pending(f.a.id);assert.equal(old.pending_count,1);
 const v3=edit(b,f);const shot=v3.project.scenes[0].shots[0].id;const cleared=b.history.clear(f.a.id,{shot_ids:[shot],through_version:v2.revision});assert.equal(cleared.pending_count,1);assert.deepEqual(b.history.pending(f.a.id).items.find(i=>i.shot_id===shot).versions,[3]);
 assert.throws(()=>b.history.clear(f.a.id,{all:true}),{code:'VIEW_VERSION_REQUIRED'});assert.throws(()=>b.history.clear(f.a.id,{all:true,through_version:4}),{code:'INVALID_VIEW_VERSION'});
 b.history.category(f.a.id,2,{reason_category:'miscommunication',expected_reason_category:'prompt_wrong'});assert.equal(b.history.version(f.a.id,2).reason_text,'这句必须逐字保留');assert.equal(b.head(f.a.id).revision,3);assert.throws(()=>b.history.category(f.a.id,2,{reason_category:'shot_feel',expected_reason_category:'prompt_wrong'}),{code:'CHANGE_CATEGORY_CONFLICT'});
 assert.equal(b.history.clear(f.a.id,{all:true,through_version:3}).pending_count,0);
});

test('stable-ID diff covers reorder/add/delete/document/scene fields and exact majority threshold',()=>{
 const a={revision:1,title:'same',scenes:[{id:'s',name:'scene',shots:[{id:'a',action:'A'},{id:'b',action:'B'}]}]},b=structuredClone(a);b.revision=999;b.scenes[0].shots.reverse();
 const reordered=storyboardDiff(a,b);assert.equal(reordered.changes.filter(c=>c.field==='$order').length,2);assert.ok(reordered.changes.every(c=>c.shot_id==='a'||c.shot_id==='b'));assert.ok(!reordered.changes.some(c=>c.field==='action'));
 b.scenes[0].shots.splice(0,1);b.scenes[0].shots.push({id:'c',action:'C'});b.title='new';b.scenes[0].name='new scene';const diff=storyboardDiff(a,b);assert.ok(diff.changes.some(c=>c.shot_id==='b'&&c.deleted));assert.ok(diff.changes.some(c=>c.shot_id==='c'&&c.before===null));assert.ok(diff.changes.some(c=>c.target_kind==='document'));assert.ok(diff.changes.some(c=>c.target_kind==='scene'));
 const exact=storyboardDiff({title:'a',note:'a',scenes:[]},{title:'b',note:'a',scenes:[]});assert.equal(exact.summary_only,false);assert.equal(storyboardDiff({title:'a',scenes:[]},{title:'x'.repeat(1000),scenes:[]}).summary_only,true);
});

test('restore makes a monotonic new version, validates assets under lock and retains later history; pruned fulls return 410',async t=>{
 const f=await fixture(t),b=f.b;const v1=init(b,f);edit(b,f);const v3=edit(b,f);const restored=b.restoreVersion(f.a.id,1,{expected_revision:3,request_id:randomUUID()});assert.equal(restored.revision,4);assert.equal(restored.project.scenes[0].shots[0].action,v1.project.scenes[0].shots[0].action);assert.equal(b.history.versions(f.a.id).total,4);assert.equal(b.history.version(f.a.id,4).restored_from,1);assert.equal(restored.initialized_at,v3.initialized_at);
 const asset=v1.project.asset_manifest.character[0].id;f.db.prepare('UPDATE creative_assets SET archived_at=? WHERE id=?').run(Date.now(),asset);assert.throws(()=>b.restoreVersion(f.a.id,2,{expected_revision:4}),e=>e.code==='RESTORE_ASSETS_INVALID'&&e.invalid_assets.some(a=>a.id===asset));assert.equal(b.head(f.a.id).revision,4);f.db.prepare('UPDATE creative_assets SET archived_at=0 WHERE id=?').run(asset);
 for(let i=0;i<48;i++)edit(b,f,p=>{p.scenes[0].shots[0].action='change '+i;});const versions=b.history.versions(f.a.id);assert.equal(versions.storage.kept_full,50);assert.equal(versions.total,52);assert.equal(versions.storage.physical_bytes,null);
 assert.throws(()=>b.history.version(f.a.id,1),{code:'VERSION_PRUNED'});assert.throws(()=>b.history.diff(f.a.id,1),{code:'VERSION_PRUNED'});assert.throws(()=>b.restoreVersion(f.a.id,1,{expected_revision:52}),{code:'VERSION_PRUNED'});assert.ok(b.history.changes(f.a.id,100).items.some(v=>v.version===1));
});

test('postcommit pruning failure cannot report save failed; subsequent save retries local cleanup',async t=>{
 const f=await fixture(t),b=f.b;init(b,f);for(let i=0;i<49;i++)edit(b,f,p=>{p.scenes[0].shots[0].action='change '+i;});
 f.db.exec("CREATE TRIGGER no_prune BEFORE UPDATE OF document_json ON storyboard_versions BEGIN SELECT RAISE(ABORT,'owned prune fault');END");const saved=edit(b,f);assert.equal(saved.revision,51);assert.equal(saved.history_cleanup,'failed');assert.equal(b.history.versions(f.a.id).storage.kept_full,51);f.db.exec('DROP TRIGGER no_prune');const next=edit(b,f);assert.equal(next.history_cleanup,'complete');assert.equal(b.history.versions(f.a.id).storage.kept_full,50);
});

test('history backups retain reason/pending/pruned markers; old backups are accepted without inventing history',async t=>{
 const f=await fixture(t),b=f.b;init(b,f);edit(b,f);const backup=b.backup();assert.equal(backup.change_history.tables.storyboard_versions.length,2);b.validateBackup(backup);
 const target=await creativeFixture();t.after(target.close);const restored=new StoryboardDatabase(target.lib,target.store).init();target.projects.remove(target.a.id);target.projects.remove(target.b.id);await restored.restore(backup);assert.equal(restored.history.versions(f.a.id).total,2);assert.ok(restored.history.pending(f.a.id).pending_count);
 const old=structuredClone(backup);delete old.change_history;old.checksum=digest({tables:old.tables,creative:old.creative});assert.ok(b.validateBackup(old));
});

test('generation landing uses generation author/raw instruction in the same transaction as task receipt',async t=>{
 const {GenerationStore}=await import('../server/storyboard-generation/store.mjs');
 const f=await fixture(t),b=f.b;init(b,f);const generation=new GenerationStore(f.lib,b).init(),id=randomUUID(),now=Date.now(),snapshot={assetStamp:generation.assetStamp(f.a.id),requirements:'原始用户指令，不得润色',script:'合成剧本'};
 f.db.prepare('INSERT INTO sb_generation_tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,f.a.id,'a'.repeat(64),canonical(snapshot),'accepted','waitingConnection','','[]','{}','',1,1,now+60000,'owned',now,now,'test-model','','合成项目');
 f.db.prepare('INSERT INTO sb_generation_locks VALUES(?,?,?,?,?)').run(f.a.id,id,1,now,now);
 f.db.exec("CREATE TRIGGER fail_generation_history BEFORE INSERT ON storyboard_pending BEGIN SELECT RAISE(ABORT,'generation history rollback');END");assert.throws(()=>generation.commit(id,{source:syntheticSource()}),/generation history rollback/);assert.equal(b.head(f.a.id).revision,1);assert.equal(generation.head(id).status,'accepted');assert.equal(b.request(f.a.id,id).completed,false);f.db.exec('DROP TRIGGER fail_generation_history');
 generation.commit(id,{source:syntheticSource()});assert.equal(generation.head(id).status,'completed');const v=b.history.version(f.a.id,2);assert.equal(v.author_kind,'generation');assert.equal(v.reason_text,snapshot.requirements);assert.equal(b.request(f.a.id,id).completed,true);
});

test('restore detects assets becoming invalid after preflight and rolls back body and version',async t=>{
 const f=await fixture(t),b=f.b;const initial=init(b,f);edit(b,f);const validate=b.validateWriteReferences.bind(b),asset=initial.project.asset_manifest.character[0].id;let injected=false;
 b.validateWriteReferences=(...args)=>{const result=validate(...args);if(!injected){injected=true;f.db.prepare('UPDATE creative_assets SET archived_at=? WHERE id=?').run(Date.now(),asset);}return result;};
 assert.throws(()=>b.restoreVersion(f.a.id,1,{expected_revision:2}),{code:'RESTORE_ASSETS_INVALID'});assert.equal(b.head(f.a.id).revision,2);assert.equal(b.history.versions(f.a.id).total,2);assert.equal(f.db.prepare('SELECT archived_at FROM creative_assets WHERE id=?').get(asset).archived_at,0);
});

test('existing empty storyboard table and partial/unknown history schema never receive implicit DDL',async t=>{
 const f=await fixture(t);for(const table of Object.keys(HISTORY_TABLES).reverse())f.db.exec('DROP TABLE '+table);
 const empty=new StoryboardDatabase(f.lib,f.store).init();assert.equal(empty.history.ready(),false);assert.throws(()=>empty.history.require(),{code:'STORYBOARD_HISTORY_MIGRATION_REQUIRED'});assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name LIKE 'storyboard_%'").get().n,4);
 installHistory(f.db);f.db.exec('ALTER TABLE storyboard_pending ADD COLUMN unknown_future_field TEXT');const unknown=new StoryboardDatabase(f.lib,f.store).init();assert.throws(()=>unknown.history.require(),{code:'STORYBOARD_HISTORY_SCHEMA_UNSUPPORTED'});assert.throws(()=>installHistory(f.db),{code:'STORYBOARD_HISTORY_SCHEMA_UNSUPPORTED'});
});

test('explicit SQLite migration creates a checked private backup before transactional DDL',async t=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util'),fs=await import('node:fs/promises'),path=await import('node:path');
 const f=await creativeFixture({onDisk:true});t.after(f.close);const b=new StoryboardDatabase(f.lib,f.store).init();init(b,f);for(const table of Object.keys(HISTORY_TABLES).reverse())f.db.exec('DROP TABLE '+table);
 const file=path.join(f.dir,'synthetic.sqlite');const {stdout}=await promisify(execFile)(process.execPath,['scripts/storyboard-history-schema.mjs','--apply-sqlite',file]);const result=JSON.parse(stdout);assert.equal(result.tables,3);const backup=new Database(result.backup,{readonly:true});try{assert.equal(backup.pragma('quick_check',{simple:true}),'ok');assert.equal(backup.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='storyboard_versions'").get().n,0);assert.equal(backup.prepare('SELECT COUNT(*) n FROM storyboard_documents').get().n,1);}finally{backup.close();}assert.equal((await fs.stat(result.backup)).mode&0o777,0o600);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM storyboard_versions').get().n,0);
});
