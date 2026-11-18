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

const netOf=(d,id)=>d.items.find(i=>i.target_id===id)?.net_unchanged;
const counts=d=>[d.pending_count,d.pending_document_count,d.net_pending_count,d.net_pending_document_count];

test('净无变化：中途出现又消失的镜头和分段，旧计数和按版本视图不变',async t=>{
 const {save,pending}=await setup(t),q={...emptyShot(),framing:'临时',action:'临时镜头'+filler};
 save(p=>{p.scenes[0].shots.splice(2,0,q);});save(p=>{shots(p).find(x=>x.id===q.id).framing='临时改过';});const last=save(p=>{p.scenes[0].shots=p.scenes[0].shots.filter(x=>x.id!==q.id);});
 let d=pending();assert.equal(netOf(d,'shot:'+q.id),true);assert.deepEqual(counts(d),[1,0,0,0]);assert.deepEqual(counts(last),[1,0,0,0]);assert.equal(d.items.length,1);assert.equal(d.pending_versions.length,3);assert.ok(d.pending_versions.every(v=>v.items.every(i=>i.net_unchanged===undefined)));
 const {b,id,save:s2}=await setup(t),start=shots(b.read(id).project)[3].id;
 s2(p=>{p.segments.push({id:'temp_seg',name:'B',start_shot_id:start});});s2(p=>{p.segments=p.segments.filter(x=>x.id!=='temp_seg');});d=b.history.pending(id);assert.equal(netOf(d,'segment:temp_seg'),true);assert.equal(d.pending_document_count,1);assert.equal(d.net_pending_document_count,0);
});

test('净无变化：改了又改回算；最终不同、只回了一个字段都不算；单次修改不算',async t=>{
 const {b,id,save,pending}=await setup(t),[,a,c,e]=shots(b.read(id).project).map(q=>q.id),old=shots(b.read(id).project)[1].framing;
 save(p=>{const q=shots(p);q[1].framing='近景';q[2].framing='近景';q[3].framing='近景';q[3].camera='推近';q[4].framing='只改一次';});
 const v=save(p=>{const q=shots(p);q[1].framing=old;q[2].framing='特写';q[3].framing='中景4';});
 const d=pending();assert.equal(netOf(d,'shot:'+a),true);assert.equal(netOf(d,'shot:'+c),false);assert.equal(netOf(d,'shot:'+e),false,'摄影机没有改回');assert.equal(d.items.find(i=>i.shot_number===5).net_unchanged,false);
 assert.deepEqual(counts(d),[4,0,3,0]);assert.equal(b.read(id).net_pending_count,3);assert.equal(v.net_pending_count,3);
 assert.deepEqual(d.items.find(i=>i.shot_id===a).versions.length,2,'标记和记录都还在');
});

test('净无变化：噪音不参与，声源等正文仍比较；删了又原样加回算，内容不同不算',async t=>{
 const {b,id,save,pending,clear}=await setup(t),q0=shots(b.read(id).project)[1],old=q0.framing,line=shots(b.read(id).project)[0].dialogue[0].source;
 save(p=>{const q=shots(p);q[1].framing='近景';q[1].source={raw:'a'};q[0].dialogue[0].source='画外';q[0].dialogue[0].import_source={raw:'a'};});
 const v=save(p=>{const q=shots(p);q[1].framing=old;q[1].source={raw:'b'};q[0].dialogue[0].source=line;q[0].dialogue[0].import_source={raw:'b'};});
 let d=pending();assert.equal(netOf(d,'shot:'+q0.id),true);assert.equal(netOf(d,'shot:'+shots(b.read(id).project)[0].id),true);clear({all:true,through_version:v.revision});
 const last=shots(b.read(id).project).filter(q=>q.id).at(5),gone=structuredClone(last),at=p=>p.scenes[0].shots;
 save(p=>{p.scenes[0].shots=at(p).filter(q=>q.id!==last.id);});save(p=>{at(p).splice(5,0,structuredClone(gone));});assert.equal(netOf(pending(),'shot:'+last.id),true);
 save(p=>{p.scenes[0].shots=at(p).filter(q=>q.id!==last.id);});save(p=>{at(p).splice(5,0,{...structuredClone(gone),action:'加回时改了'+filler});});assert.equal(netOf(pending(),'shot:'+last.id),false);
});

test('净无变化：移动回原位算，只移一次或移到别处不算；换场景要回到原场景',async t=>{
 const {b,id,save,pending,clear}=await setup(t),all=shots(b.read(id).project),m=all[1].id,move=(p,to)=>{const l=p.scenes[0].shots,i=l.findIndex(q=>q.id===m),[q]=l.splice(i,1);l.splice(to,0,q);};
 save(p=>move(p,4));assert.equal(netOf(pending(),'shot:'+m),false,'只移一次是真实移动');let v=save(p=>move(p,1));assert.equal(netOf(pending(),'shot:'+m),true);clear({all:true,through_version:v.revision});
 save(p=>move(p,4));save(p=>move(p,3));assert.equal(netOf(pending(),'shot:'+m),false);v=b.head(id);clear({all:true,through_version:v.revision});
 const cross=shots(b.read(id).project)[5].id,to=(p,from,dest,at)=>{const i=p.scenes[from].shots.findIndex(q=>q.id===cross),[q]=p.scenes[from].shots.splice(i,1);p.scenes[dest].shots.splice(at,0,q);};
 save(p=>to(p,0,1,0));save(p=>to(p,1,0,5));assert.equal(netOf(pending(),'shot:'+cross),true);
});

test('净无变化：只记摘要或缺记录按有变化；部分清除后重新判断；只清折叠目标不影响其它',async t=>{
 const {b,id,save,pending,clear,f}=await setup(t),[,a,c]=shots(b.read(id).project).map(q=>q.id),old=shots(b.read(id).project)[1].framing;
 const v1=save(p=>{shots(p)[1].framing='近景';});const v2=save(p=>{shots(p)[1].framing=old;shots(p)[2].framing='远景';});
 let d=pending();assert.equal(netOf(d,'shot:'+a),true);assert.deepEqual(counts(d),[2,0,1,0]);
 const fresh=()=>new StoryboardDatabase(f.lib,f.store).init().history.pending(id),h=b.head(id).id,sql=f.db.prepare('UPDATE storyboard_versions SET summary_only=? WHERE document_id=? AND version=?');
 sql.run(1,h,v1.revision);assert.equal(netOf(fresh(),'shot:'+a),false,'只记摘要不能折叠');sql.run(0,h,v1.revision);
 const lost=f.db.prepare("SELECT * FROM storyboard_changes WHERE document_id=? AND version=? AND target_id=?").all(h,v1.revision,'shot:'+a);f.db.prepare('DELETE FROM storyboard_changes WHERE document_id=? AND version=? AND target_id=?').run(h,v1.revision,'shot:'+a);assert.equal(netOf(fresh(),'shot:'+a),false,'缺逐字段记录不能折叠');for(const r of lost)b.history.insert('storyboard_changes',r);
 const cleared=clear({target_ids:['shot:'+a],through_version:v2.revision,expected_revision:v2.revision});assert.deepEqual(counts(cleared),[1,0,1,0]);assert.deepEqual(pending().items.map(i=>i.shot_id),[c],'只清折叠目标');
 const {b:b2,id:id2,save:s2,clear:c2}=await setup(t),q=shots(b2.read(id2).project)[1],orig=q.framing,x=s2(p=>{shots(p)[1].framing='近景';}),y=s2(p=>{shots(p)[1].framing=orig;});assert.equal(b2.read(id2).net_pending_count,0);
 const after=c2({all:true,version:x.revision,through_version:y.revision,expected_revision:y.revision});assert.deepEqual(counts(after),[1,0,1,0],'清掉一版后只剩一次真实修改');assert.equal(netOf(b2.history.pending(id2),'shot:'+q.id),false);
});

test('计数缓存：未看记录不变不重读改动记录；新增或清除即失效',async t=>{
 const {b,id,save,clear}=await setup(t),h=b.history,real=h.changeRows.bind(h);save(p=>{shots(p)[1].framing='近景';});let scans=0;h.changeRows=(doc,versions)=>{if(versions.length)scans++;return real(doc,versions);};
 const docId=b.head(id).id,first=h.counts(docId);scans=0;assert.deepEqual(h.counts(docId),first);b.read(id);assert.equal(scans,0);
 const user=save(p=>{shots(p)[2].framing='用户改';},'','user');assert.equal(user.net_pending_count,1);assert.equal(scans,0,'用户保存不改变未看记录');
 const v=save(p=>{shots(p)[3].framing='再改';});assert.ok(scans>0);assert.equal(v.net_pending_count,2);scans=0;assert.equal(clear({all:true,through_version:v.revision}).net_pending_count,0);assert.equal(scans,0,'清空后没有记录可读');
});
