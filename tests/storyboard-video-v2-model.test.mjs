import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {captureSnapshot,compareSnapshot} from '../server/storyboard-video-v2/model.mjs';
import {v2Schema,V2_TABLES} from '../server/storyboard-video-v2/schema.mjs';
const context={instanceId:'instance',projectId:'project',documentId:'document',initializedAt:1,storyboardRevision:1};
function project(){return {scenes:[{id:'scene',location:'房间',story_time:'白天',interior_exterior:'内',spatial_setup:'桌在左',shots:Array.from({length:4},(_,i)=>({id:'shot_'+i,duration_ms:3000,framing:'全景',action:'抬头',camera:'固定',first_frame:'低头',continuity:'不换手',sound:'风声',character_ids:['char'],character_presence:[{character_id:'char',mode:'visible'}],reference_bindings:[],audio_continuations:[],dialogue:[{id:'dialogue_'+i,character_id:'char',source:'现场',text:'来了',performance:'平静'}]}))}],reference_bindings:[]};}
const capture=(p,shotIds=['shot_1','shot_2'],extra={})=>captureSnapshot({project:p,context,shotIds,...extra});
test('provenance snapshot fixes ordered identity and full input hash without modifying source',()=>{
 const p=project(),before=structuredClone(p),s=capture(p);assert.deepEqual(p,before);assert.equal(s.inputHash,capture(p).inputHash);assert.deepEqual(s.shotIds,['shot_1','shot_2']);assert.deepEqual(s.runs[0].shotIds,s.shotIds);
 assert.throws(()=>capture(p,['shot_2','shot_1']),{code:'VIDEO_V2_INVALID_INPUT'});assert.throws(()=>capture(p,['shot_9']),{code:'SHOT_NOT_FOUND'});assert.throws(()=>capture(p,['shot_1','shot_1']),{code:'VIDEO_V2_INVALID_INPUT'});
});
test('semantic whitelist detects all formal categories but ignores technical revision, transition, note and JSON format',()=>{
 const p=project(),s=capture(p),q=p.scenes[0].shots[1];q.revision=10;q.transition='淡出';q.design_note='随意';p.revision=99;assert.equal(compareSnapshot(s,capture(p)).needsReview,false);
 for(const [field,category]of [['framing','framing'],['action','action'],['physical_feedback','action'],['environment_feedback','action'],['result','action'],['camera','camera'],['first_frame','first_frame'],['continuity','continuity'],['sound','sound_dialogue']]){const n=structuredClone(p);n.scenes[0].shots[1][field]='不同';assert.ok(compareSnapshot(s,capture(n)).reasons.some(r=>r.category===category),field);}
 const n=structuredClone(p);n.scenes[0].shots[1].duration_ms++;assert.ok(compareSnapshot(s,capture(n)).reasons.some(r=>r.category==='duration'));
 n.scenes[0].location='外面';assert.ok(compareSnapshot(s,capture(n)).reasons.some(r=>r.category==='scene'));
});
test('external assets and out-of-range dialogue dependencies change without a storyboard revision change',()=>{
 const p=project();p.scenes[0].shots[1].audio_continuations=[{source_shot_id:'shot_0',dialogue_id:'dialogue_0'}];const s=capture(p,['shot_1']);
 p.scenes[0].shots[0].dialogue[0].text='别走';assert.ok(compareSnapshot(s,capture(p,['shot_1'])).reasons.some(r=>r.category==='audio_continuation'));
 const dep={shot_1:{references:[{imageHash:'before'}]}};const initial=capture(p,['shot_1'],{dependencies:dep});dep.shot_1.references[0].imageHash='after';assert.ok(compareSnapshot(initial,capture(p,['shot_1'],{dependencies:dep})).reasons.some(r=>r.category==='references'));
 dep.shot_1.unverifiable=['image'];const invalid=compareSnapshot(initial,capture(p,['shot_1'],{dependencies:dep}));assert.equal(invalid.canReview,false);assert.equal(invalid.disabledReason,'DEPENDENCY_UNVERIFIABLE');
});
test('range comparison uses selected contiguous runs; gaps remain unbound; deleted and rebuilt IDs cannot be reviewed',()=>{
 const p=project(),continuous=capture(p),gapped=capture(p,['shot_0','shot_3']);p.scenes[0].shots.splice(2,0,{id:'new',duration_ms:1});
 assert.ok(compareSnapshot(continuous,capture(p)).reasons.some(r=>r.category==='shot_range'&&r.shotIds.includes('new')));
 assert.equal(compareSnapshot(gapped,capture(p,['shot_0','shot_3'])).needsReview,false);
 p.scenes[0].shots=p.scenes[0].shots.filter(s=>s.id!=='shot_1');assert.equal(compareSnapshot(continuous,capture(p,continuous.shotIds,{allowMissing:true})).canReview,false);
 const rebuilt=capture(project(),undefined,{context:{...context,initializedAt:2}});assert.equal(compareSnapshot(continuous,rebuilt).disabledReason,'STORYBOARD_GENERATION_CHANGED');
});
test('review baseline and content identity stay separate from immutable original provenance',()=>{
 const p=project(),original=capture(p);p.scenes[0].shots[1].camera='推近';const reviewed=capture(p);assert.equal(compareSnapshot(original,reviewed).needsReview,true);assert.equal(compareSnapshot(reviewed,capture(p)).needsReview,false);assert.equal(compareSnapshot(original,capture(p)).needsReview,true);
 assert.ok(compareSnapshot(reviewed,capture(p),{videoChanged:true}).reasons.some(r=>r.category==='video_content'));
 assert.equal(compareSnapshot(reviewed,capture(p),{mediaVerified:false}).canReview,false);
});
test('7-table SQLite schema installs idempotently with identity constraints; MySQL DDL is explicitly generated only',()=>{
 const db=new Database(':memory:');try{for(const sql of [...v2Schema(),...v2Schema()])db.exec(sql);for(const [name,fields]of Object.entries(V2_TABLES))assert.deepEqual(db.prepare('PRAGMA table_info('+name+')').all().map(c=>c.name),Object.keys(fields));
 assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='v2_shot_candidates'").get());const mysql=v2Schema(true).join('\n');assert.match(mysql,/UNIQUE\(video_id\)/);assert.match(mysql,/VARCHAR\(64\)/);assert.match(mysql,/ENGINE=InnoDB/);assert.equal(v2Schema(true).length,7);
 }finally{db.close();}
});
