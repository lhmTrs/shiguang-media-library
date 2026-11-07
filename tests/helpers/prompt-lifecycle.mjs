import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {definition,compile,canonical} from '../../server/prompt-templates/model.mjs';

export const fixture=()=>definition({name:'合成情绪模板',description:'仅验收使用 🧪',category:'测试',body:'固定规则：保持原文。\n主题：{{主题}}\n风格：{{风格}}\n时长：{{时长}}\n\n补充：{{补充}}',fields:[
 {key:'主题',type:'textarea',required:true,default:''},
 {key:'风格',type:'multiselect',required:true,options:['纪实','温暖','悬疑'],default:['纪实']},
 {key:'时长',type:'number',required:true,default:'15'},
 {key:'补充',type:'text',required:false,default:''},
]});
export const inputs={主题:'中文对白「不改写」\n{{风格}} 🧪',风格:['温暖','纪实'],时长:'20',补充:''};

// Reused unchanged on SQLite and a fresh real MySQL 8.2 server.
export function lifecycle(store){
 const activeCount=store.list().items.length,deletedCount=store.list({deleted:true}).items.length;
 const original=store.create(fixture()),id=original.id;
 assert.equal(original.created_at,original.updated_at);assert.equal(original.current_version,1);
 const firstVersion=store.versions(id)[0];
 const draft=store.saveDraft(id,{template_revision:1,expected_revision:0,values:inputs});
 assert.deepEqual(draft.values,inputs);assert.equal(draft.created_at,draft.updated_at);
 assert.throws(()=>store.saveDraft(id,{template_revision:1,expected_revision:0,values:{...inputs,主题:'错误覆盖'}}),e=>e.status===409);
 const nextDraft=store.saveDraft(id,{template_revision:1,expected_revision:1,values:inputs});
 assert.equal(nextDraft.created_at,draft.created_at);assert.ok(nextDraft.updated_at>draft.updated_at);
 const request={id:randomUUID(),template_revision:1,values:inputs};
 const record=store.generate(id,request);assert.equal(record.prompt,compile(fixture(),inputs).prompt);
 assert.match(record.prompt,/温暖、纪实/);assert.match(record.prompt,/\{\{风格\}\}/);assert.ok(!record.prompt.includes('补充：'));
 assert.deepEqual(store.generate(id,request),record);assert.equal(store.records(id).total,1);
 assert.throws(()=>store.generate(id,{...request,values:{...inputs,主题:'冲突'}}),e=>e.status===409);
 assert.throws(()=>store.generate(id,{...request,id:randomUUID(),values:{...inputs,风格:['不存在']}}),e=>e.status===400);
 const edited=store.save(id,{...fixture(),name:'合成模板 v2',body:fixture().body+'\n第二版固定规则'},1);
 assert.equal(edited.created_at,original.created_at);assert.ok(edited.updated_at>original.updated_at);assert.equal(edited.current_version,2);
 assert.throws(()=>store.save(id,fixture(),1),e=>e.status===409);
 assert.throws(()=>store.saveDraft(id,{template_revision:1,expected_revision:2,values:inputs}),e=>e.status===409);
 assert.deepEqual(store.version(id,1),firstVersion);assert.deepEqual(store.records(id).items[0],record);
 const rolled=store.rollback(id,1,2);assert.equal(rolled.current_version,3);assert.deepEqual(rolled.definition,original.definition);
 assert.equal(store.version(id,3).rollback_of,1);assert.equal(store.versions(id).length,3);assert.equal(store.get(id).draft.version,1);
 const removed=store.setDeleted(id,true,3);assert.ok(removed.deleted_at);assert.equal(removed.created_at,original.created_at);
 assert.equal(store.list().items.length,activeCount);assert.equal(store.list({deleted:true}).items.length,deletedCount+1);assert.equal(store.versions(id).length,3);assert.equal(store.records(id).total,1);assert.deepEqual(store.get(id).draft.values,inputs);
 assert.throws(()=>store.save(id,fixture(),4),e=>e.status===409);
 assert.throws(()=>store.generate(id,{...request,id:randomUUID(),template_revision:4}),e=>e.status===409);
 const restored=store.setDeleted(id,false,4);assert.equal(restored.deleted_at,null);assert.equal(store.list().items.length,activeCount+1);assert.equal(restored.current_version,3);
 assert.equal(store.records(id,1.5).total,1);
 store.setDeleted(id,true,5);
 const backup=store.backup();assert.deepEqual(store.validateBackup(backup),backup.tables);
 for(const rows of Object.values(backup.tables))for(const row of rows){assert.ok(Number.isSafeInteger(row.created_at));assert.ok(Number.isSafeInteger(row.updated_at));}
 return {id,record,backup};
}

export function orderLifecycle(store){
 const created=['排序甲','排序乙','排序丙'].map(name=>store.create({...fixture(),name}));
 const original=store.list().items.map(r=>r.id),next=[...original].reverse(),versions=store.versions(created[0].id),revision=store.get(created[0].id).revision;
 assert.deepEqual(store.reorder({ids:next,expected_ids:original}).items.map(r=>r.id),next);
 assert.equal(store.get(created[0].id).revision,revision);assert.deepEqual(store.versions(created[0].id),versions);
 const before=store.backup().checksum;
 assert.throws(()=>store.reorder({ids:original,expected_ids:original}),e=>e.status===409);assert.equal(store.backup().checksum,before);
 assert.throws(()=>store.reorder({ids:[next[0],next[0]],expected_ids:next}),e=>e.status===400);assert.equal(store.backup().checksum,before);
 const t=store.get(created[0].id);store.save(t.id,{...t.definition,description:'编辑不改变手动顺序'},t.revision);assert.deepEqual(store.list().items.map(r=>r.id),next);
 const appended=store.create({...fixture(),name:'新增位于末尾'});assert.deepEqual(store.list().items.map(r=>r.id),[...next,appended.id]);const appendedAgain=store.create({...fixture(),name:'再次新增仍位于末尾'});assert.deepEqual(store.list().items.map(r=>r.id),[...next,appended.id,appendedAgain.id]);
 const current=store.list().items.map(r=>r.id);store.reorder({ids:current,expected_ids:current});
 const middle=current[1],removed=store.setDeleted(middle,true,store.get(middle).revision),remaining=store.list().items.map(r=>r.id);
 store.reorder({ids:[...remaining].reverse(),expected_ids:remaining});store.setDeleted(middle,false,removed.revision);assert.equal(store.list().items[1].id,middle);
 const manual=store.list().items.map(r=>r.id);store.init();assert.deepEqual(store.list().items.map(r=>r.id),manual);
 return {ids:manual,backup:store.backup()};
}
