import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {creativeFixture} from './helpers/creative-fixture.mjs';
import {syntheticSource} from './helpers/storyboard-fixture.mjs';
import {StoryboardDatabase} from '../server/storyboard/database.mjs';
import * as M from '../server/storyboard/shared/model.mjs';
function source(){const p=syntheticSource();p.asset_manifest.scene.push({id:'s2',name:'另一个场景'});p.asset_manifest.prop.push({id:'p2',name:'另一个道具'});const first=p.scenes[0].shots[0],second=M.emptyShot(),third=M.emptyShot();second.scene_asset_id='s2';second.prop_ids=['p2'];second.audio_continuations=[{source_shot_id:first.id,dialogue_id:first.dialogue[0].id,note:'仅承接声音'}];third.action='陈川看着合成包，只是文本提及';p.scenes[0].shots.push(second,third);return p;}
test('关联镜号使用明确人物/对白/语音承接、场景继承覆盖和道具编号，正文同名不会误关联',async()=>{
 const f=await creativeFixture();try{const db=new StoryboardDatabase(f.lib,f.store).init(),r=db.initialize(f.a.id,{source:source(),expected_revision:null,request_id:randomUUID()}),manifest=r.project.asset_manifest,links=id=>f.store.associatedShots(id),numbers=id=>links(id).items.map(i=>i.number);
 assert.deepEqual(numbers(manifest.character[0].id),['01','02']);assert.deepEqual(links(manifest.character[0].id).items[1].reasons,['语音承接']);assert.deepEqual(numbers(manifest.character[1].id),[]);
 assert.deepEqual(numbers(manifest.scene[0].id),['01','03']);assert.deepEqual(numbers(manifest.scene[1].id),['02']);assert.deepEqual(numbers(manifest.prop[0].id),['01']);assert.deepEqual(numbers(manifest.prop[1].id),['02']);
 const data=links(manifest.character[0].id);assert.equal(data.projectId,f.a.id);assert.equal(data.documentId,r.project.document_id);assert.equal(data.revision,r.revision);assert.equal(data.items[0].shotId,r.project.scenes[0].shots[0].id);
 }finally{await f.close();}
});
test('人物改名、镜头重排/删除及重新初始化后，镜号和关系从当前分镜读取，不复用旧同名资产',async()=>{
 const f=await creativeFixture();try{const db=new StoryboardDatabase(f.lib,f.store).init(),input=source();let r=db.initialize(f.a.id,{source:input,expected_revision:null,request_id:randomUUID()}),id=r.project.characters[0].id,a=f.store.get(id);a.name='新人物名';await f.store.save(id,a,a.revision);const before=f.store.associatedShots(id).items.map(i=>i.shotId);
 let p=structuredClone(r.project);p.scenes[0].shots.reverse();r=db.save(f.a.id,{project:p,expected_revision:r.revision});let links=f.store.associatedShots(id);assert.deepEqual(links.items.map(i=>i.number),['02','03']);assert.equal(links.items[1].shotId,before[0]);
 p=structuredClone(r.project);p.scenes[0].shots=p.scenes[0].shots.filter(q=>q.id!==before[1]);r=db.save(f.a.id,{project:p,expected_revision:r.revision});assert.equal(f.store.associatedShots(id).items.length,1);
 db.initialize(f.a.id,{source:input,expected_revision:r.revision,request_id:randomUUID()});assert.equal(f.store.associatedShots(id).listed,false);assert.deepEqual(f.store.associatedShots(id).items,[]);
 }finally{await f.close();}
});
test('未初始化、公共库和同名项目副本独立，查询不修改分镜/资产版本',async()=>{
 const f=await creativeFixture();try{const db=new StoryboardDatabase(f.lib,f.store).init(),r=db.initialize(f.a.id,{source:source(),expected_revision:null,request_id:randomUUID()}),other=await f.store.create({project_id:f.b.id,kind:'character',name:'陈川'}),pub=f.store.scopes().items.find(s=>s.project_kind==='public'),publicAsset=await f.store.create({project_id:pub.id,kind:'character',name:'陈川'});
 const before=db.backup().checksum;for(const a of [other,publicAsset]){const result=f.store.associatedShots(a.id);assert.equal(result.projectId,a.project_id);assert.equal(result.initialized,false);assert.deepEqual(result.items,[]);}f.store.associatedShots(r.project.characters[0].id);assert.equal(db.backup().checksum,before);assert.throws(()=>f.store.associatedShots(randomUUID()),e=>e.status===404);
 }finally{await f.close();}
});
