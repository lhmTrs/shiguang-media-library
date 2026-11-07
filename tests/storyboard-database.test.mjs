import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { creativeFixture, addLook, addImage } from './helpers/creative-fixture.mjs';
import { StoryboardDatabase } from '../server/storyboard/database.mjs';
import { ProjectAssets } from '../server/project-assets/store.mjs';
import { canonical, digest } from '../server/project-assets/model.mjs';
import * as M from '../server/storyboard/shared/model.mjs';
import { syntheticSource } from './helpers/storyboard-fixture.mjs';

const init=(db,f,source=syntheticSource(),extra={})=>db.initialize(f.a.id,{source,filename:'合成.json',request_id:randomUUID(),expected_revision:db.head(f.a.id)?.revision??null,...extra});
test('完整初始化、活动名称复用、资料图片保留；清单全量保护和项目隔离',async()=>{
 const f=await creativeFixture();try{const db=new StoryboardDatabase(f.lib,f.store).init();
 let c=await f.store.create({project_id:f.a.id,kind:'character',name:'陈川'});c.base_info='现有资料';addLook(c);addImage(c,f.media);c=await f.store.save(c.id,c,c.revision);
 await f.store.create({project_id:f.b.id,kind:'character',name:'不出场人物'});
 const preview=db.preview(f.a.id,{source:syntheticSource()});assert.deepEqual([preview.assets.filter(a=>a.action==='reuse').length,preview.assets.filter(a=>a.action==='create').length],[1,3]);
 const r=init(db,f);assert.equal(r.project.characters[0].id,c.id);assert.equal(f.store.get(c.id).base_info,'现有资料');assert.equal(f.store.get(c.id).images[0].media_asset_id,f.media);assert.deepEqual(r.project.extensions,{unknown:{keep:true}});
 assert.equal(r.project.scenes[0].shots[0].prop_ids[0],r.project.asset_manifest.prop[0].id);assert.equal(r.project.scenes[0].scene_asset_id,r.project.asset_manifest.scene[0].id);
 for(const kind of ['character','scene','prop'])for(const item of r.project.asset_manifest[kind]){const a=f.store.get(item.id);assert.equal(a.archived_at,0);assert.equal(a.storyboard_protected,true);assert.throws(()=>f.store.archive(a.id,true,a.revision),/清单/);await assert.rejects(f.store.save(a.id,{...a,archived_at:Date.now()},a.revision),/清单/);}
 assert.throws(()=>db.read(f.b.id),e=>e.status===404);assert.throws(()=>db.preview(f.store.scopes().items.find(p=>p.project_kind==='public').id,{source:syntheticSource()}),/普通项目/);
 }finally{await f.close();}
});
test('改名按ID实时显示；重新初始化按新名称匹配、释放旧关系但保留旧档案',async()=>{
 const f=await creativeFixture();try{const db=new StoryboardDatabase(f.lib,f.store).init(),a=init(db,f),id=a.project.characters[0].id;let c=f.store.get(id);c.name='陈海';await f.store.save(id,c,c.revision);
 const renamed=db.read(f.a.id);assert.equal(renamed.project.characters[0].name,'陈海');assert.equal(renamed.project.scenes[0].shots[0].dialogue[0].character_id,id);assert.equal(renamed.project.scenes[0].shots[0].action,'陈川放下包。原文不能改。');
 const b=init(db,f);assert.equal(b.project.project_id,a.project.project_id);assert.ok(b.revision>a.revision);assert.notEqual(b.project.characters[0].id,id);assert.equal(f.store.get(id).name,'陈海');assert.equal(f.store.get(id).storyboard_protected,false);f.store.archive(id,true,f.store.get(id).revision);
 assert.throws(()=>db.save(f.a.id,{project:a.project,expected_revision:a.revision}),e=>e.status===409);
 }finally{await f.close();}
});
test('初始化固定请求回执幂等，新请求同文件仍重置；清单不能经保存清除',async()=>{
 const f=await creativeFixture();try{const db=new StoryboardDatabase(f.lib,f.store).init(),source=syntheticSource(),request_id=randomUUID(),input={source,request_id,expected_revision:null};
 const a=db.initialize(f.a.id,input),b=db.initialize(f.a.id,input);assert.equal(b.repeated,true);assert.equal(b.revision,a.revision);assert.equal(db.request(f.a.id,request_id).receipt.revision,a.revision);
 assert.throws(()=>db.initialize(f.a.id,{...input,source:{...source,title:'不同'}}),e=>e.status===409);
 const edit=structuredClone(a.project);edit.scenes[0].shots=[];const saved=db.save(f.a.id,{project:edit,expected_revision:a.revision});assert.equal(saved.project.asset_manifest.character.length,2);
 const remove=structuredClone(saved.project);remove.asset_manifest.character.pop();remove.characters.pop();assert.throws(()=>db.save(f.a.id,{project:remove,expected_revision:saved.revision}),/不能移除/);
 const again=init(db,f,source);assert.equal(again.project.scenes[0].shots.length,1);assert.ok(again.revision>saved.revision);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM storyboard_import_requests').get().n,2);
 }finally{await f.close();}
});
test('失败在资产/正文/关联/回执任一步均整体回滚，旧数据和保护仍完整',async()=>{
 const f=await creativeFixture();try{const db=new StoryboardDatabase(f.lib,f.store).init();init(db,f);const source=syntheticSource();source.characters[0].name='新人物';source.asset_manifest.character[0].name='新人物';
 for(const table of ['creative_asset_versions','storyboard_asset_links','storyboard_import_requests']){
  const before=db.backup().checksum;f.db.exec(`CREATE TRIGGER fail_init BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`);
  assert.throws(()=>init(db,f,source),/synthetic failure/);assert.equal(db.backup().checksum,before);f.db.exec('DROP TRIGGER fail_init');
 }
 }finally{await f.close();}
});
test('归档0/时间戳唯一、同名多归档、活动冲突恢复、旧schema和备份迁移',async()=>{
 const f=await creativeFixture();try{
 let a=await f.store.create({project_id:f.a.id,kind:'character',name:'同名'});a=f.store.archive(a.id,true,a.revision);
 let b=await f.store.create({project_id:f.a.id,kind:'character',name:'同名'});b=f.store.archive(b.id,true,b.revision);assert.ok(b.archived_at>a.archived_at);
 const c=await f.store.create({project_id:f.a.id,kind:'character',name:'同名'});assert.equal(c.archived_at,0);assert.throws(()=>f.store.archive(a.id,false,a.revision),/名称已存在/);
 // Reproduce the previous nullable column + three-column unique constraint.
 const columns=f.db.prepare('PRAGMA table_info(creative_assets)').all().map(c=>c.name);
 f.db.prepare('DELETE FROM creative_assets WHERE id<>?').run(c.id); f.db.exec('ALTER TABLE creative_assets RENAME TO legacy_assets');
 const sql=f.db.prepare("SELECT sql FROM sqlite_master WHERE name='legacy_assets'").get().sql.replace('legacy_assets','creative_assets').replace(/archived_at` INTEGER NOT NULL DEFAULT 0/,'archived_at` INTEGER').replace('UNIQUE(project_id,kind,name_key,archived_at)','UNIQUE(project_id,kind,name_key)');f.db.exec(sql);
 f.db.exec(`INSERT INTO creative_assets(${columns.join(',')}) SELECT ${columns.map(k=>k==='archived_at'?'NULL':k).join(',')} FROM legacy_assets`);
 f.db.exec('DROP TABLE legacy_assets');f.db.prepare('UPDATE creative_schema SET version=1').run();
 new ProjectAssets(f.lib).init();assert.equal(f.db.prepare('SELECT version FROM creative_schema').get().version,2);assert.equal(f.db.prepare('PRAGMA table_info(creative_assets)').all().find(c=>c.name==='archived_at').notnull,1);
 assert.ok((await fs.readdir(f.dir+'/backups')).some(n=>n.startsWith('creative-before-v2-')));
 }finally{await f.close();}
});
test('完整备份跨新SQLite恢复，重算摘要的悬空关系被拒绝且无部分资产',async()=>{
 const f=await creativeFixture(),g=await creativeFixture();try{const db=new StoryboardDatabase(f.lib,f.store).init(),target=new StoryboardDatabase(g.lib,g.store).init();const r=init(db,f);const backup=db.backup();g.projects.remove(g.a.id);g.projects.remove(g.b.id);await target.restore(backup);assert.equal(target.read(f.a.id).revision,r.revision);assert.deepEqual(target.backup().tables,backup.tables); for(const a of backup.creative.tables.creative_assets) assert.deepEqual(g.store.get(a.id),f.store.get(a.id));
 const damaged=structuredClone(backup);damaged.tables.storyboard_asset_links[0].asset_id=randomUUID();damaged.checksum=digest({tables:damaged.tables,creative:damaged.creative});const before=target.backup().checksum;await assert.rejects(target.restore(damaged),/关系/);assert.equal(target.backup().checksum,before);
 }finally{await f.close();await g.close();}
});
test('中文清单与局部编号不猜测、原文保留、重复与清单遗漏在写入前拒绝',async()=>{
 const f=await creativeFixture();try{const db=new StoryboardDatabase(f.lib,f.store).init();
 const source={'完整分镜':true,'项目名称':'中文合成','总时长秒':3,'素材清单':{'人物':[{'编号':'C1','名称':'甲'}],'场景':[{'编号':'S1','名称':'甲的客厅'}],'道具':[{'编号':'P1','名称':'包'}]},'场景':[{'场次':1,'地点':'客厅','场景编号':'S1','开始秒':0,'结束秒':3,'时长秒':3,'镜头':[{'镜号':'01','开始秒':0,'结束秒':3,'时长秒':3,'画面与人物动作':'原文','摄影机设计':'原运镜','人物编号':['C1'],'道具编号':['P1'],'声音与对白':{'对白':[{'人物编号':'C1','台词':'原对白'}]}}]}]};
 const r=init(db,f,source);assert.deepEqual(r.project.import_source.original,source);assert.equal(r.project.characters[0].name,'甲');assert.equal(r.project.scenes[0].shots[0].dialogue[0].text,'原对白');
 const before=db.backup().checksum;
 for(const change of [s=>s.complete=false,s=>s['素材清单']['人物'].push('甲'),s=>s['场景'][0]['镜头'][0]['道具编号']=['missing']]) {const bad=structuredClone(source);change(bad);assert.throws(()=>init(db,f,bad));assert.equal(db.backup().checksum,before);}
 }finally{await f.close();}
});

test('归档同名不恢复；无对白清单人物仍保护；直接篡改归属与ID均拒绝',async()=>{
 const f=await creativeFixture();try{const db=new StoryboardDatabase(f.lib,f.store).init();let archived=await f.store.create({project_id:f.a.id,kind:'character',name:'陈川'});addLook(archived);addImage(archived,f.media);archived=await f.store.save(archived.id,archived,archived.revision);archived=f.store.archive(archived.id,true,archived.revision);
 const r=init(db,f);assert.notEqual(r.project.characters[0].id,archived.id);assert.ok(f.store.get(archived.id).archived_at>0);assert.equal(f.store.get(archived.id).images[0].media_asset_id,f.media);
 const silent=f.store.get(r.project.characters[1].id);assert.throws(()=>f.store.archive(silent.id,true,silent.revision),/清单/);await assert.rejects(f.store.save(silent.id,{...silent,project_id:f.b.id},silent.revision),/项目或类型/);
 const foreign=await f.store.create({project_id:f.b.id,kind:'prop',name:'外项目道具'}),bad=structuredClone(r.project);bad.asset_manifest.prop.push({id:foreign.id,name:foreign.name});assert.throws(()=>db.save(f.a.id,{project:bad,expected_revision:r.revision}),/当前项目/);
 }finally{await f.close();}
});
test('同一毫秒多次归档仍唯一，旧版资产备份可验证转换',async t=>{
 const f=await creativeFixture();try{const now=Date.now();t.mock.method(Date,'now',()=>now);let a=await f.store.create({project_id:f.a.id,kind:'character',name:'重复名'});a=f.store.archive(a.id,true,a.revision);let b=await f.store.create({project_id:f.a.id,kind:'character',name:'重复名'});b=f.store.archive(b.id,true,b.revision);assert.equal(a.archived_at,now);assert.equal(b.archived_at,now+1);
 const backup=f.store.backup();backup.schema_version=1;backup.tables.creative_schema[0].version=1;backup.checksum=digest({tables:backup.tables,projects:backup.projects});const converted=f.store.validateBackup(backup);assert.equal(converted.schema_version,2);assert.equal(converted.tables.creative_schema[0].version,2);
 }finally{await f.close();}
});
