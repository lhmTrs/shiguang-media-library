// 待看去噪与按版本查看：全部用合成分镜和内存 SQLite。
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {creativeFixture} from './helpers/creative-fixture.mjs';
import {syntheticSource} from './helpers/storyboard-fixture.mjs';
import {StoryboardDatabase} from '../server/storyboard/database.mjs';
import {emptyShot} from '../server/storyboard/shared/model.mjs';
import {withSegments} from '../server/storyboard/shared/segments.mjs';

const filler='合成画面描述'.repeat(30);
function source(){
 const p=syntheticSource(),first=p.scenes[0];first.name='第一场';first.shots[0].action+=filler;
 const shot=(n)=>({...emptyShot(),framing:'中景'+n,action:`合成动作${n}${filler}`,camera:'固定'+filler,source:{raw:n}});
 for(let n=2;n<=6;n++)first.shots.push(shot(n));
 first.source={raw:'scene'};
 p.scenes.push({...structuredClone({...first,shots:[]}),id:'scene_second',name:'第二场',shots:[7,8,9].map(shot)});
 p.import_source={filename:'合成.json',original:{v:1}};
 return withSegments(p);
}
async function setup(t){
 const f=await creativeFixture();t.after(f.close);const b=new StoryboardDatabase(f.lib,f.store).init();
 const first=b.initialize(f.a.id,{source:source(),request_id:randomUUID(),expected_revision:null});
 const save=(edit,reason='合成原话',author='agent')=>{const cur=b.read(f.a.id),project=structuredClone(cur.project);edit(project);return b.save(f.a.id,{project,expected_revision:cur.revision,request_id:randomUUID(),change:author==='agent'?{author,reason_category:'shot_feel',reason_text:reason}:{author}});};
 return {f,b,id:f.a.id,first,save,pending:()=>b.history.pending(f.a.id),clear:input=>b.history.clear(f.a.id,input)};
}
const shots=p=>p.scenes.flatMap(s=>s.shots);
const rawPending=f=>f.db.prepare('SELECT * FROM storyboard_pending ORDER BY id').all();
const total=d=>d.pending_count+d.pending_document_count;

test('删一镜：后面的镜头不进待看，只显示被删的一条；永久记录里的顺延还在',async t=>{
 const {b,id,save,pending,f}=await setup(t),gone=shots(b.read(id).project)[2];
 const v=save(p=>{p.scenes[0].shots.splice(2,1);},'删掉第三镜');
 assert.ok(rawPending(f).length>5,'存量待看行不动');assert.equal(v.pending_count,1);
 const d=pending();assert.equal(total(d),1);assert.deepEqual(d.items.map(i=>i.shot_id),[gone.id]);
 const item=d.items[0];assert.equal(item.deleted,true);assert.deepEqual(item.fields,['$entity']);assert.deepEqual(Object.keys(item.before.$entity).sort(),['action','framing','number']);assert.equal(item.before.$entity.number,3);assert.equal(item.current_number,null);
 assert.equal(b.history.changes(id,1).items[0].changes.filter(c=>c.field==='$number').length,6,'改动记录保留全部顺延');
 const log=b.history.versionChanges(id,v.revision);assert.equal(log.items.length,1);assert.equal(log.noise.filter(n=>n.field==='$number').length,6);
});

test('插一镜同样不牵连后面的镜头',async t=>{
 const {save,pending}=await setup(t),q={...emptyShot(),framing:'特写',action:'合成新镜头'+filler};
 save(p=>{p.scenes[0].shots.splice(1,0,q);});const d=pending();
 assert.deepEqual(d.items.map(i=>[i.shot_id,i.fields]),[[q.id,['$entity']]]);assert.equal(d.items[0].before.$entity,null);assert.equal(d.items[0].after.$entity.framing,'特写');
});

test('真实修改不被藏：删镜同一版里改了后面的镜头，只显示真实字段',async t=>{
 const {b,id,save,pending}=await setup(t),target=shots(b.read(id).project)[4];
 save(p=>{p.scenes[0].shots.splice(1,1);p.scenes[0].shots.find(q=>q.id===target.id).framing='大特写';});
 const item=pending().items.find(i=>i.shot_id===target.id);assert.deepEqual(item.fields,['framing']);assert.equal(item.before.framing,'中景5');assert.equal(item.after.framing,'大特写');assert.equal(item.shot_number,4);assert.equal(item.current_number,4);assert.ok(!Object.hasOwn(item.before,'$number'));assert.equal(pending().pending_count,2);
});

test('真实移动显示「从镜 X 到镜 Y」，被它挤动的镜头不算',async t=>{
 const {b,id,save,pending}=await setup(t),all=shots(b.read(id).project),mover=all[1];
 save(p=>{const list=p.scenes[0].shots,[q]=list.splice(1,1);list.splice(4,0,q);},'把镜2挪到后面');
 const d=pending();assert.deepEqual(d.items.map(i=>i.shot_id),[mover.id]);const item=d.items[0];assert.deepEqual(item.fields,['$move']);assert.equal(item.before.$move.number,2);assert.equal(item.after.$move.number,5);
});

test('移动和删镜同时发生仍能认出真实移动；换场景算移动',async t=>{
 const {b,id,save,pending,clear}=await setup(t),all=shots(b.read(id).project),[dropped,mover]=[all[1],all[5]];
 const v=save(p=>{const list=p.scenes[0].shots;list.splice(1,1);const i=list.findIndex(q=>q.id===mover.id),[q]=list.splice(i,1);list.splice(1,0,q);});
 assert.deepEqual(pending().items.map(i=>i.shot_id).sort(),[dropped.id,mover.id].sort());const moved=pending().items.find(i=>i.shot_id===mover.id);assert.equal(moved.before.$move.number,6);assert.equal(moved.after.$move.number,2);
 clear({all:true,through_version:v.revision});
 const crosser=shots(b.read(id).project).at(-4);save(p=>{const i=p.scenes[0].shots.findIndex(q=>q.id===crosser.id),[q]=p.scenes[0].shots.splice(i,1);p.scenes[1].shots.unshift(q);});
 const d=pending();assert.deepEqual(d.items.map(i=>i.shot_id),[crosser.id]);assert.equal(d.items[0].before.$move.scene_name,'第一场');assert.equal(d.items[0].after.$move.scene_name,'第二场');
});

test('场次换序只算一处整体修改；同版的场内真实移动仍显示；完整版已清理时按噪音处理',async t=>{
 const {b,id,save,pending,f,clear}=await setup(t),second=shots(b.read(id).project)[6];
 const reorder=p=>{p.scenes.reverse();p.segments[0].start_shot_id=shots(p)[0].id;};
 const v=save(reorder);let d=pending();assert.deepEqual(d.items.filter(i=>i.target_kind!=='segment').map(i=>[i.target_kind,i.fields]),[['document',['$scene_order']]]);assert.equal(d.pending_count,0);
 clear({all:true,through_version:v.revision});
 const mover=second.id,w=save(p=>{reorder(p);const list=p.scenes[1].shots,i=list.findIndex(q=>q.id===mover),[q]=list.splice(i,1);list.push(q);});
 d=pending();assert.deepEqual(d.items.filter(i=>i.target_kind==='shot').map(i=>i.shot_id),[mover]);
 f.db.prepare('UPDATE storyboard_versions SET document_json=NULL,byte_size=0 WHERE document_id=? AND version=?').run(b.head(id).id,w.revision-1);
 const again=new StoryboardDatabase(f.lib,f.store).init();const old=again.history.pending(id);assert.deepEqual(old.items.filter(i=>i.target_kind!=='segment').map(i=>i.target_kind),['document']);assert.ok(again.history.changes(id,1).items[0].changes.some(c=>c.shot_id===mover&&c.field==='$number'),'改动记录仍可查');
});

test('source、import_source 和嵌套原始数据不算修改；声源是正文，算修改',async t=>{
 const {b,id,save,pending,clear}=await setup(t);
 const a=save(p=>{const q=shots(p);q[1].source={raw:'new'};p.scenes[0].source={raw:'changed'};p.import_source={filename:'另一个.json'};p.characters[0].source={raw:'x'};q[0].dialogue[0].import_source={raw:'x'};});
 assert.equal(total(a),0);assert.deepEqual(pending().items,[]);assert.deepEqual(pending().pending_versions,[]);
 clear({all:true,through_version:a.revision});save(p=>{shots(p)[0].dialogue[0].source='画外';});
 const item=pending().items[0];assert.deepEqual(item.fields,['dialogue']);assert.equal(item.after.dialogue[0].source,'画外');assert.ok(!Object.hasOwn(item.after.dialogue[0],'import_source'));assert.ok(b.history.versionChanges(id,a.revision).noise.some(n=>n.field==='source'));
});

test('去噪对存量生效：读取和计数不写库，只有噪音的版本不进翻页',async t=>{
 const {b,id,save,pending,f}=await setup(t);
 const a=save(p=>{shots(p)[1].framing='近景';},'第一次');save(p=>{shots(p)[3].source={raw:'noise'};},'只有噪音');const c=save(p=>{shots(p)[2].camera='推近';},'第三次');
 const before=rawPending(f),checksum=b.backup().checksum;const d=pending();assert.equal(before.length,3);assert.deepEqual(d.pending_versions.map(v=>v.version),[c.revision,a.revision]);assert.equal(total(d),d.items.length);assert.equal(total(b.read(id)),2);assert.deepEqual(rawPending(f),before);assert.equal(b.backup().checksum,checksum);
 assert.equal(d.pending_versions[0].is_current,true);assert.equal(d.pending_versions[1].is_current,false);
});

test('每版显示自己的原话；全部未看里一处跨多版时各版原话都在，改前取最早、改后取最新',async t=>{
 const {b,id,save,pending}=await setup(t),q=shots(b.read(id).project)[1];
 const a=save(p=>{shots(p)[1].framing='近景';},'第一句');const c=save(p=>{shots(p)[1].framing='特写';},'第二句');const d=pending();
 assert.deepEqual(d.pending_versions.map(v=>[v.version,v.reason_text]),[[c.revision,'第二句'],[a.revision,'第一句']]);assert.equal(d.pending_versions[1].items[0].after.framing,'近景');
 const item=d.items.find(i=>i.shot_id===q.id);assert.deepEqual(item.events.map(e=>e.reason_text),['第一句','第二句']);assert.deepEqual(item.versions,[a.revision,c.revision]);assert.equal(item.before.framing,'中景2');assert.equal(item.after.framing,'特写');
});

test('只清这一版不连带更早版本；旧的 through_version 语义不变',async t=>{
 const {b,id,save,pending,clear}=await setup(t);
 const a=save(p=>{shots(p)[1].framing='近景';},'一');const c=save(p=>{shots(p)[2].framing='远景';},'二');const e=save(p=>{shots(p)[1].framing='特写';},'三');
 const r=clear({all:true,version:c.revision,through_version:e.revision,expected_revision:e.revision});assert.equal(r.cleared_events,1);assert.deepEqual(pending().pending_versions.map(v=>v.version),[e.revision,a.revision]);assert.equal(r.pending_count,1);
 clear({all:true,version:e.revision,through_version:e.revision,expected_revision:e.revision});assert.deepEqual(pending().items[0].versions,[a.revision],'更晚的清掉后更早的还在');
 const g=save(p=>{shots(p)[3].framing='全景';});clear({all:true,through_version:a.revision});assert.deepEqual(pending().pending_versions.map(v=>v.version),[g.revision],'through_version 仍清到该版为止');assert.equal(b.head(id).revision,g.revision);
});

test('版本保护：新清除方式必须带 expected_revision，版本变了 409 且不清除',async t=>{
 const {save,pending,clear}=await setup(t),a=save(p=>{shots(p)[1].framing='近景';});
 assert.throws(()=>clear({all:true,version:a.revision,through_version:a.revision}),{code:'EXPECTED_REVISION_REQUIRED'});
 const c=save(p=>{shots(p)[2].framing='远景';});
 assert.throws(()=>clear({all:true,version:a.revision,through_version:a.revision,expected_revision:a.revision}),e=>e.code==='PENDING_REVISION_CHANGED'&&e.status===409&&e.current_revision===c.revision);
 assert.throws(()=>clear({target_ids:['document:$document'],through_version:a.revision,expected_revision:a.revision}),{code:'PENDING_REVISION_CHANGED'});
 assert.throws(()=>clear({all:true,version:c.revision,through_version:a.revision,expected_revision:c.revision}),{code:'INVALID_VIEW_VERSION'});
 assert.throws(()=>clear({all:true,target_ids:['x'],through_version:c.revision,expected_revision:c.revision}),{code:'INVALID_INPUT'});assert.equal(pending().items.length,2);
});

test('场景、整体设置能按目标清除，不必全部看过',async t=>{
 const {b,id,save,pending,clear}=await setup(t),scene=b.read(id).project.scenes[0].id;
 const v=save(p=>{p.scenes[0].location='合成新地点';p.title='合成新标题';shots(p)[1].framing='近景';});assert.equal(v.pending_document_count,2);
 clear({target_ids:['scene:'+scene],through_version:v.revision,expected_revision:v.revision});assert.deepEqual(pending().items.map(i=>i.target_kind),['document','shot']);
 const r=clear({target_ids:['document:$document'],through_version:v.revision,expected_revision:v.revision});assert.equal(r.pending_document_count,0);assert.equal(r.pending_count,1);
});

test('改动记录展开一版不清待看；只记摘要的版本有完整版就重新比对，已清理就如实说',async t=>{
 const {b,id,save,pending,f}=await setup(t),a=save(p=>{shots(p)[1].framing='近景';});const before=rawPending(f);
 const seen=b.history.versionChanges(id,a.revision);assert.equal(seen.detail,'full');assert.deepEqual(seen.items.map(i=>i.fields),[['framing']]);assert.deepEqual(rawPending(f),before);assert.equal(pending().pending_count,1);
 const big=save(p=>{for(const q of shots(p)){q.action='完全重写'+'新'.repeat(600);q.camera='重写'+'新'.repeat(600);}},'整集重写');assert.equal(b.history.version(id,big.revision).summary_only,true);
 const page=pending().pending_versions[0];assert.equal(page.summary_only,true);assert.ok(page.items.length>=9);assert.equal(page.items[0].before,null);
 assert.equal(b.history.versionChanges(id,big.revision).detail,'rebuilt');assert.ok(b.history.versionChanges(id,big.revision).items.some(i=>i.fields.includes('action')));
 f.db.prepare('UPDATE storyboard_versions SET document_json=NULL,byte_size=0 WHERE document_id=? AND version=?').run(b.head(id).id,a.revision);const pruned=b.history.versionChanges(id,big.revision);assert.equal(pruned.detail,'summary');assert.deepEqual(pruned.items,[]);
 assert.throws(()=>b.history.versionChanges(id,999),{code:'VERSION_NOT_FOUND'});
});

test('只记摘要的版本里只有顺序变化的镜头按噪音处理；用户自己的保存不进待看；改动记录的镜数已去噪',async t=>{
 const {b,id,save,pending,f}=await setup(t),user=save(p=>{shots(p)[1].framing='用户改';},'','user');assert.equal(total(user),0);assert.deepEqual(pending().pending_versions,[]);
 const v=save(p=>{p.scenes[0].shots.splice(1,1);});assert.equal(b.history.versions(id,{limit:1}).items[0].content_shot_count,1);assert.ok(b.history.versions(id,{limit:1}).items[0].changed_shot_count>1);
 const h=b.head(id);f.db.prepare('UPDATE storyboard_versions SET summary_only=1 WHERE document_id=? AND version=?').run(h.id,v.revision);const fresh=new StoryboardDatabase(f.lib,f.store).init().history.pending(id);
 assert.deepEqual(fresh.items.map(i=>i.fields),[['$entity']]);
});
