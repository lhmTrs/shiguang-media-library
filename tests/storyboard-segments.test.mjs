import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../server/storyboard/shared/segments.mjs';
const make=(durations=[10000,10000,10000,10000])=>S.withSegments({document_id:'doc',scenes:[{id:'scene1',shots:durations.slice(0,2).map((duration_ms,i)=>({id:'s'+i,duration_ms}))},{id:'scene2',shots:durations.slice(2).map((duration_ms,i)=>({id:'s'+(i+2),duration_ms}))}]});
const rejects=(fn,code)=>assert.throws(fn,{code});

test('legacy read is pure, stable, cross-scene; cuts strictly cover global order',()=>{
 const raw={document_id:'doc',scenes:[{shots:[{id:'s',duration_ms:1}]}]},snapshot=structuredClone(raw);
 assert.deepEqual(S.withSegments(raw),S.withSegments(raw));assert.deepEqual(raw,snapshot);
 const p=make();assert.equal(S.segmentSummary(p).segments[0].duration_ms,40000);
 const split=S.splitSegment(p,'s2',{id:'b'});assert.deepEqual(S.segmentSummary(split).segments.map(s=>s.shot_ids),[['s0','s1'],['s2','s3']]);
 for(const segments of [[],[{id:'a',name:'A',start_shot_id:'s1'}],[{id:'a',name:'A',start_shot_id:'s0'},{id:'b',name:'B',start_shot_id:'s0'}]])rejects(()=>S.segmentSummary({...p,segments}),'SEGMENT_STRUCTURE_INVALID');
});

test('empty canonical input, mode validation, exact integer duration boundaries',()=>{
 const empty={scenes:[],segments:[{id:'empty',name:'A',start_shot_id:null}]};assert.deepEqual(S.withSegments(empty).segments,[]);
 for(const [mode,limit]of [['seedance_2_5',30000],['seedance_2_0',15000],['camera',null]])assert.equal(S.getSegmentLimit({mode}),limit);
 rejects(()=>S.getSegmentLimit({mode:'custom',custom_limit_ms:1.2}),'SEGMENT_MODE_INVALID');
 rejects(()=>S.segmentSummary(make([Number.MAX_SAFE_INTEGER,1])),'SEGMENT_STRUCTURE_INVALID');
 rejects(()=>S.segmentSummary(make([1.5])),'SEGMENT_STRUCTURE_INVALID');
 for(const limit of [15000,30000,12345]) {
  const p=make([limit]);p.segment_settings={mode:'custom',custom_limit_ms:limit};
  assert.equal(S.segmentSummary(p).segments[0].overlong,false);p.scenes[0].shots[0].duration_ms++;assert.equal(S.segmentSummary(p).segments[0].overlong,true);
 }
});

test('names use bijective base ordering, immutable names, saved ledger and nearest empty base',()=>{
 assert.equal(S.compareSegmentNames('Z','AA'),-1);assert.equal(S.compareSegmentNames('A2','A10'),-1);
 for(const name of ['a','A0','A01','A-1',''])rejects(()=>S.segmentNameParts(name),'SEGMENT_NAME_INVALID');
 let p=make();p.segment_used_names.push('B','C','D','A1');
 assert.equal(S.nextSegmentName(p,p.segments[0].id),'A2');assert.equal(S.nearestEmptyBase(p,p.segments[0].id),'B');
 p=S.splitSegment(p,'s2',{id:'b',name:'D1'});assert.equal(S.nearestEmptyBase(p,p.segments[0].id),'B');
 const candidate=structuredClone(p);candidate.segments[0].name='Q';rejects(()=>S.validateSegmentSave(p,candidate),'SEGMENT_NAME_IMMUTABLE');
 candidate.segments[0].name='A';candidate.segment_used_names=['poison'];candidate.segment_used_ids=[];
 const saved=S.validateSegmentSave(p,candidate);assert.ok(saved.segment_used_names.includes('B'));assert.ok(!saved.segment_used_names.includes('poison'));
});

test('split numbered names remains cut order; merge preserves identity and retired ledger',()=>{
 let p=make([1,1,1,1]);p=S.splitSegment(p,'s2',{id:'two'});p=S.splitSegment(p,'s3',{id:'three'});p=S.splitSegment(p,'s1',{id:'four'});
 assert.deepEqual(p.segments.map(s=>s.name),['A','A3','A1','A2']);
 const merged=S.mergeSegment(p,'two');assert.ok(merged.segment_used_names.includes('A1'));assert.ok(merged.segment_used_ids.includes('two'));
 assert.equal(merged.segments[1].id,'four');rejects(()=>S.splitSegment(merged,'s2',{id:'two'}),'SEGMENT_ID_REUSED');
 rejects(()=>S.mergeSegment(p,p.segments[0].id),'SEGMENT_STRUCTURE_INVALID');
});

test('explicit nearest empty-name overwrite user only; agents cannot launder short ledgers',()=>{
 const p=make([1,1,1,1]);p.segment_used_names.push('B','C');
 const candidate=S.splitSegment(p,'s2',{id:'new',name:'B'}),overwrites=[{segment_id:'new',name:'B'}];
 rejects(()=>S.validateSegmentSave(p,candidate),'SEGMENT_NAME_REUSED');
 assert.equal(S.validateSegmentSave(p,candidate,{author:'user',overwrites}).segments[1].name,'B');
 for(const author of ['agent','generation'])rejects(()=>S.validateSegmentSave(p,candidate,{author,overwrites}),'SEGMENT_NAME_REUSED');
 const farther=S.splitSegment(p,'s2',{id:'other',name:'C'});rejects(()=>S.validateSegmentSave(p,farther,{overwrites:[{segment_id:'other',name:'C'}]}),'SEGMENT_NAME_REUSED');
});

test('boundary insert before B belongs B, after A belongs A; delete head/group; ambiguous insertion rejects',()=>{
 const p=S.splitSegment(make([1,1,1,1]),'s2',{id:'b'}),next=structuredClone(p);
 next.scenes[1].shots.unshift({id:'new',duration_ms:1});
 rejects(()=>S.reconcileSegmentCuts(p,next),'SEGMENT_INSERT_CONTEXT_REQUIRED');
 const before=S.reconcileSegmentCuts(p,next,{insertions:[{shot_id:'new',anchor_shot_id:'s2',side:'before'}]});assert.equal(before.segments[1].start_shot_id,'new');
 const after=S.reconcileSegmentCuts(p,next,{insertions:[{shot_id:'new',anchor_shot_id:'s1',side:'after'}]});assert.equal(after.segments[1].start_shot_id,'s2');
 next.scenes[1].shots=next.scenes[1].shots.filter(s=>s.id==='s3');assert.equal(S.reconcileSegmentCuts(p,next).segments[1].start_shot_id,'s3');
 next.scenes.pop();const deleted=S.reconcileSegmentCuts(p,next);assert.equal(deleted.segments.length,1);assert.ok(deleted.segment_used_ids.includes('b'));
 const reordered=structuredClone(p);reordered.scenes[1].shots.splice(1,0,reordered.scenes[0].shots.pop());rejects(()=>S.reconcileSegmentCuts(p,reordered),'SEGMENT_STRUCTURE_INVALID');
});

test('empty deletion then reinsertion uses fresh basic name and ID; old PUT protects multi-segments',()=>{
 const p=make([1]);const empty=S.reconcileSegmentCuts(p,{...p,scenes:[]});
 const reinsert=S.reconcileSegmentCuts(empty,{...empty,scenes:[{shots:[{id:'new',duration_ms:1}]}]},{firstSegmentId:'fresh'});
 assert.equal(reinsert.segments[0].name,'B');
 const legacy=structuredClone(p);delete legacy.segments;assert.equal(S.validateSegmentSave(p,legacy).segments[0].id,p.segments[0].id);
 const multi=S.splitSegment(make([1,1]),'s1',{id:'b'}),missing=structuredClone(multi);delete missing.segments;rejects(()=>S.validateSegmentSave(multi,missing),'SEGMENTS_REQUIRED');
});

test('save rejects only new/grown overlong, smaller cap permits unchanged; init strict; restore bypasses duration',()=>{
 const p=make([30000]),over=make([30001]);
 rejects(()=>S.validateSegmentSave(p,over),'SEGMENT_TOO_LONG');
 assert.equal(S.validateSegmentSave(over,over).segments.length,1);
 const smaller=structuredClone(over);smaller.segment_settings={mode:'seedance_2_0',custom_limit_ms:null};assert.ok(S.validateSegmentSave(over,smaller));
 rejects(()=>S.validateSegmentSave(over,over,{kind:'initialize'}),'SEGMENT_TOO_LONG');assert.ok(S.validateSegmentSave(p,over,{kind:'restore'}));
 const unlimited=structuredClone(over);unlimited.segment_settings={mode:'camera',custom_limit_ms:null};assert.ok(S.validateSegmentSave(null,unlimited,{kind:'initialize'}));
 const missing=structuredClone(p);delete missing.segments;rejects(()=>S.validateSegmentSave(null,missing,{kind:'initialize'}),'SEGMENTS_REQUIRED');
});

test('restore unions historical registry; initialization resets names but preserves IDs; resurrection is allowed',()=>{
 const old=make([1,1]),historic=S.splitSegment(old,'s1',{id:'historic'}),current=S.mergeSegment(historic,'historic');
 current.segment_used_names.push('Z');const restored=S.validateSegmentSave(current,historic,{kind:'restore'});assert.ok(restored.segment_used_names.includes('Z'));assert.equal(restored.segments[1].id,'historic');
 const input=make([1]);input.segments[0].id='fresh';input.segment_used_names=['evil'];
 const initialized=S.validateSegmentSave(current,input,{kind:'initialize',author:'generation'});assert.deepEqual(initialized.segment_used_names,['A']);assert.ok(initialized.segment_used_ids.includes('historic'));assert.ok(initialized.segment_used_ids.includes('fresh'));
 const retired=structuredClone(current);retired.segments.push({id:'historic',name:'Q',start_shot_id:'s1'});rejects(()=>S.validateSegmentSave(current,retired),'SEGMENT_ID_REUSED');
});

test('structured diff preserves identity and cut points, legacy materialization has no event',()=>{
 const p=make([1,1,1]),split=S.splitSegment(p,'s1',{id:'b'});assert.equal(S.segmentChanges(p,split)[0].type,'add');
 const moved=structuredClone(split);moved.segments[1].start_shot_id='s2';const event=S.segmentChanges(split,moved)[0];assert.equal(event.type,'move_start');assert.equal(event.before.start_number,'02');assert.equal(event.after.start_number,'03');
 const removed=S.segmentChanges(split,S.mergeSegment(split,'b'))[0];assert.equal(removed.merged_into.id,p.segments[0].id);
 const raw=structuredClone(p);delete raw.segments;assert.deepEqual(S.segmentChanges(raw,p),[]);
});
