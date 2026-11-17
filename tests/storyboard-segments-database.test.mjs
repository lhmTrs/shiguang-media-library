import fs from 'node:fs/promises';
import {RuleLibrary} from '../server/storyboard-generation/rules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {creativeFixture} from './helpers/creative-fixture.mjs';
import {syntheticSource} from './helpers/storyboard-fixture.mjs';
import {StoryboardDatabase} from '../server/storyboard/database.mjs';
import {canonical,digest} from '../server/project-assets/model.mjs';
import {parseInitialization} from '../server/storyboard/import.mjs';
import {projectAgentGuide} from '../server/project-agent-guide.mjs';
import {validateOutput,outputSchema} from '../server/storyboard-generation/validation.mjs';
import * as M from '../server/storyboard/shared/model.mjs';
import * as S from '../server/storyboard/shared/segments.mjs';
async function fixture(t){const f=await creativeFixture();t.after(f.close);const b=new StoryboardDatabase(f.lib,f.store).init();return {...f,projectB:f.b,b};}
function source(){const p=syntheticSource();p.scenes[0].shots.push({...M.emptyShot(),id:'second',duration_ms:3000});return p;}
const init=(f,p=source(),extra={})=>f.b.initialize(f.a.id,{source:p,request_id:randomUUID(),expected_revision:f.b.head(f.a.id)?.revision??null,...extra});
const save=(f,p,extra={})=>f.b.save(f.a.id,{project:p,expected_revision:f.b.head(f.a.id).revision,request_id:randomUUID(),...extra});
const agent={author:'agent',reason_text:'按用户指定位置切段',reason_category:'shot_feel'};
function chinese(){return {'格式版本':'2.0.0','完整分镜':true,'项目名称':'合成中文','故事核心':'合成','画幅':'16:9','总时长秒':3,'素材清单':{'人物':[],'场景':[{'编号':'S1','名称':'合成房间','描述':'','年龄':'','身份':'','人物特点':''}],'道具':[]},'分段':[{'段':'A','起始镜号':'01'}],'分割模式':{'模式':'seedance_2_5','自定义上限毫秒':null},'场景':[{'场次':1,'地点':'房间','场景编号':'S1','时间':'白天','内外景':'内','空间设定':'空房','开始秒':0,'结束秒':3,'时长秒':3,'镜头':[{'镜号':'01','开始秒':0,'结束秒':3,'时长秒':3,'景别与角度':'全景','画面与人物动作':'灯亮起','摄影机设计':'固定','人物编号':[],'道具编号':[],'场景编号':'S1','声音与对白':{'环境与动作声':'风声','对白':[],'承接对白':null},'剪辑衔接':''}]}]};}

test('both new imports require explicit segments, Chinese only one syntax, full generation schema enforces segments',()=>{
 const p=source();delete p.segments;assert.throws(()=>parseInitialization(p),{code:'SEGMENTS_REQUIRED'});
 const c=chinese(),bad=structuredClone(c);delete bad['分段'];assert.throws(()=>parseInitialization(bad),{code:'SEGMENTS_REQUIRED'});
 assert.equal(parseInitialization(c).project.segments[0].name,'A');assert.equal(validateOutput(JSON.stringify(c)).summary.shots,1);
 assert.ok(outputSchema.required.includes('分段'));assert.throws(()=>validateOutput(JSON.stringify(bad)));
 const mixed=structuredClone(c);mixed['场景'][0]['镜头'][0]['段']='A';assert.throws(()=>parseInitialization(mixed),/顶层分段/);
 const duplicate=structuredClone(c);duplicate['场景'][0]['镜头'].push(structuredClone(duplicate['场景'][0]['镜头'][0]));assert.throws(()=>parseInitialization(duplicate),/唯一连续/);
 const malformed=source();malformed.segments[0].name='A0';assert.throws(()=>parseInitialization(malformed),{code:'SEGMENT_NAME_INVALID'});
 const over=chinese();over['分割模式']={'模式':'custom','自定义上限毫秒':2999};assert.throws(()=>validateOutput(JSON.stringify(over)),{code:'SEGMENT_TOO_LONG'});
 const fractional=JSON.stringify(chinese()).replace('"自定义上限毫秒":null','"自定义上限毫秒":3000.00000000000001').replace('"模式":"seedance_2_5"','"模式":"custom"');assert.throws(()=>validateOutput(fractional));
});

test('legacy GET and segment read never write, noop does not materialize; first true save persists without fake segment diff',async t=>{
 const f=await fixture(t),first=init(f),raw=JSON.parse(f.b.head(f.a.id).document_json);
 for(const key of ['segments','segment_settings','segment_used_names','segment_used_ids'])delete raw[key];
 f.db.prepare('UPDATE storyboard_documents SET document_json=? WHERE id=?').run(canonical(raw),first.project.document_id);
 const checksum=f.b.backup().checksum,one=f.b.read(f.a.id),two=f.b.read(f.a.id);assert.equal(one.project.segments[0].id,two.project.segments[0].id);
 assert.equal(f.b.segments(f.a.id).segments[0].duration_ms,6000);assert.equal(f.b.backup().checksum,checksum);
 assert.equal(save(f,one.project).unchanged,true);assert.equal(f.b.backup().checksum,checksum);
 one.project.scenes[0].shots[0].action+='新';const edited=save(f,one.project,{change:agent});assert.ok(JSON.parse(f.b.head(f.a.id).document_json).segments);
 const events=f.b.history.changes(f.a.id).items[0].changes;assert.ok(events.some(c=>c.field==='action'));assert.ok(!events.some(c=>c.target_kind==='segment'||c.field.includes('segment')));
 assert.equal(edited.pending_document_count,0);
});

test('cuts and modes use existing history/pending transaction; through_version and replay protect concurrent work',async t=>{
 const f=await fixture(t),first=init(f);const split=S.splitSegment(first.project,'second',{id:'new_segment'});
 const request={project:split,expected_revision:first.revision,request_id:randomUUID(),change:agent};const second=f.b.save(f.a.id,request);
 assert.equal(f.b.save(f.a.id,request).repeated,true);assert.throws(()=>f.b.save(f.a.id,{...request,request_id:randomUUID()}),{status:409});
 assert.equal(second.pending_document_count,1);let pending=f.b.history.pending(f.a.id);assert.equal(pending.items[0].target_kind,'segment');assert.equal(pending.items[0].after.$segment.name,'A1');
 const event=f.b.history.changes(f.a.id).items[0].changes.find(c=>c.target_kind==='segment');assert.equal(event.segment_event.type,'add');assert.equal(event.segment_event.after.start_number,'02');
 const mode=structuredClone(second.project);mode.segment_settings={mode:'camera',custom_limit_ms:null};const third=save(f,mode,{change:agent});
 const clear=f.b.history.clear(f.a.id,{all:true,through_version:second.revision});assert.equal(clear.pending_document_count,1);assert.equal(f.b.history.pending(f.a.id).items[0].target_kind,'document');
 f.b.history.clear(f.a.id,{shot_ids:[mode.scenes[0].shots[0].id],through_version:third.revision});assert.equal(f.b.history.pending(f.a.id).pending_document_count,1);
 const before=f.b.backup().checksum;const changed=structuredClone(third.project);changed.segment_settings={mode:'seedance_2_0',custom_limit_ms:null};
 f.db.exec("CREATE TRIGGER fail_segment BEFORE INSERT ON storyboard_pending BEGIN SELECT RAISE(ABORT,'segment atomic fault');END");assert.throws(()=>save(f,changed,{change:agent}),/segment atomic fault/);assert.equal(f.b.backup().checksum,before);f.db.exec('DROP TRIGGER fail_segment');
});

test('saved name and ID registry cannot be poisoned/shortened; restore union; reinitialization resets names and remints IDs',async t=>{
 const f=await fixture(t),first=init(f),split=save(f,S.splitSegment(first.project,'second',{id:'used'}));
 const merged=save(f,S.mergeSegment(split.project,'used'));const restored=f.b.restoreVersion(f.a.id,2,{expected_revision:merged.revision,request_id:randomUUID()});assert.equal(restored.project.segments[1].id,'used');
 const next=structuredClone(restored.project);next.segments.pop();next.segment_used_names=[];next.segment_used_ids=['poison'];const current=save(f,next);assert.ok(current.project.segment_used_names.includes('A1'));assert.ok(current.project.segment_used_ids.includes('used'));assert.ok(!current.project.segment_used_ids.includes('poison'));
 const reused=S.splitSegment(current.project,'second',{id:'fresh',name:'A1'});assert.throws(()=>save(f,reused,{change:agent}),{code:'SEGMENT_NAME_REUSED'});
 const reset=init(f);assert.deepEqual(reset.project.segment_used_names,['A']);assert.ok(reset.project.segment_used_ids.includes('used'));assert.notEqual(reset.project.segments[0].id,first.project.segments[0].id);
 const another=init(f);assert.notEqual(another.project.segments[0].id,reset.project.segments[0].id);
});

test('server duration rejection has details and is atomic; smaller cap and historic overlong restore are allowed',async t=>{
 const f=await fixture(t),p=source();p.scenes[0].shots[0].duration_ms=27000;const first=init(f,p),before=f.b.backup().checksum,over=structuredClone(first.project);over.scenes[0].shots[0].duration_ms++;
 assert.throws(()=>save(f,over),e=>e.code==='SEGMENT_TOO_LONG'&&e.details.segments[0].duration_ms===30001&&e.details.segments[0].previous_duration_ms===30000);assert.equal(f.b.backup().checksum,before);
 const smaller=structuredClone(first.project);smaller.segment_settings={mode:'seedance_2_0',custom_limit_ms:null};const second=save(f,smaller);assert.equal(S.segmentSummary(second.project).segments[0].overlong,true);
 second.project.scenes[0].shots[0].action+=' unrelated';assert.equal(save(f,second.project).unchanged,false);
 const short=structuredClone(f.b.read(f.a.id).project);short.scenes[0].shots[0].duration_ms=1;save(f,short);
 const restored=f.b.restoreVersion(f.a.id,2,{expected_revision:f.b.head(f.a.id).revision,request_id:randomUUID()});assert.equal(S.segmentSummary(restored.project).segments[0].duration_ms,30000);
 const tooLong=source();tooLong.scenes[0].shots[0].duration_ms=30000;assert.throws(()=>init(f,tooLong),{code:'SEGMENT_TOO_LONG'});
});

test('legacy historical snapshot restores as A, old snapshot unchanged; backup round trip includes segment targets',async t=>{
 const f=await fixture(t),first=init(f),second=save(f,S.splitSegment(first.project,'second',{id:'used'}),{change:agent});
 const historic=f.db.prepare('SELECT * FROM storyboard_versions WHERE document_id=? AND version=1').get(first.project.document_id),legacy=JSON.parse(historic.document_json);
 for(const key of ['segments','segment_settings','segment_used_names','segment_used_ids'])delete legacy[key];const text=canonical(legacy);f.db.prepare('UPDATE storyboard_versions SET document_json=?,byte_size=? WHERE id=?').run(text,Buffer.byteLength(text),historic.id);
 const restored=f.b.restoreVersion(f.a.id,1,{expected_revision:second.revision});assert.equal(restored.project.segments[0].name,'A');assert.ok(restored.project.segment_used_names.includes('A1'));assert.equal(f.b.history.full(f.b.history.row(first.project.document_id,1)).segments,undefined);
 const backup=f.b.backup();assert.ok(backup.change_history.tables.storyboard_pending.some(p=>p.target_kind==='segment'));assert.ok(f.b.validateBackup(backup));
 const g=await fixture(t);g.projects.remove(g.a.id);g.projects.remove(g.projectB.id);await g.b.restore(backup);assert.deepEqual(g.b.read(f.a.id).project.segments,restored.project.segments);
 const legacyBackup=structuredClone(backup);for(const row of legacyBackup.tables.storyboard_documents){const p=JSON.parse(row.document_json);for(const key of ['segments','segment_settings','segment_used_names','segment_used_ids'])delete p[key];row.document_json=canonical(p);}delete legacyBackup.change_history;legacyBackup.checksum=digest({tables:legacyBackup.tables,creative:legacyBackup.creative});
 assert.ok(f.b.validateBackup(legacyBackup));const h=await fixture(t);h.projects.remove(h.a.id);h.projects.remove(h.projectB.id);await h.b.restore(legacyBackup);assert.equal(h.b.read(f.a.id).project.segments[0].name,'A');assert.equal(JSON.parse(h.b.head(f.a.id).document_json).segments,undefined);
});

test('dynamic project guide exposes both init forms, author rules, limits and readonly endpoint',()=>{
 const guide=projectAgentGuide({project:{id:'synthetic',name:'合成'},origin:'http://127.0.0.1:1234',instanceId:'fixture'});
 for(const term of ['/segments','storyboards.segments','segment_used_names','segment_name_overwrites','起始镜号','SEGMENTS_REQUIRED','SEGMENT_TOO_LONG','through_version','custom_limit_ms'])assert.ok(guide.includes(term),term);
});

test('user overwrite marker is enforced at save boundary and produces structured overwrite without deleting history',async t=>{
 const f=await fixture(t),p=source();p.scenes[0].shots.push({...M.emptyShot(),id:'third'});
 p.segments.push({id:'inputB',name:'B',start_shot_id:'second'},{id:'inputC',name:'C',start_shot_id:'third'});
 const first=init(f,p),oldB=first.project.segments[1].id,merged=save(f,S.mergeSegment(first.project,oldB));
 const cut=S.splitSegment(merged.project,'second',{id:'new_B',name:'B'}),marker={segment_name_overwrites:[{segment_id:'new_B',name:'B'}]};
 assert.throws(()=>save(f,cut,{...marker,change:agent}),{code:'SEGMENT_NAME_REUSED'});assert.throws(()=>save(f,cut),{code:'SEGMENT_NAME_REUSED'});
 const saved=save(f,cut,marker);assert.equal(saved.project.segments[1].name,'B');assert.ok(saved.project.segment_used_ids.includes(oldB));assert.equal(f.b.history.version(f.a.id,1).project.segments[1].id,oldB);
 const event=f.b.history.changes(f.a.id).items[0].changes.find(c=>c.target_id==='segment:new_B');assert.equal(event.segment_event.type,'overwrite');assert.equal(event.segment_event.name,'B');assert.equal(saved.pending_document_count,0);
});

test('bundled director package and published initialization schema agree on required segments',async()=>{const rule=await RuleLibrary.prototype.sharedDirector.call({});assert.equal(rule.revision,'2026-11-17-json-v2-segments');const packaged=JSON.parse(rule.package.files.find(f=>f.path==='references/initialization.schema.json').text),published=JSON.parse(await fs.readFile(new URL('../server/storyboard/initialization.schema.json',import.meta.url),'utf8'));assert.deepEqual(packaged,published);assert.ok(packaged.required.includes('分段'));});

test('old single-segment PUT can change mode; empty-document old PUT allocates fresh identity without recycling A',async t=>{const f=await fixture(t),first=init(f),oldClient=structuredClone(first.project);delete oldClient.segments;oldClient.segment_settings={mode:'camera'};const changed=save(f,oldClient);assert.equal(changed.project.segment_settings.mode,'camera');assert.equal(changed.project.segment_settings.custom_limit_ms,null);const empty={...changed.project,scenes:[],segments:[]};const cleared=save(f,empty);const insert=structuredClone(cleared.project);insert.scenes=[{...first.project.scenes[0],shots:[M.emptyShot()]}];delete insert.segments;const next=save(f,insert);assert.equal(next.project.segments[0].name,'B');assert.notEqual(next.project.segments[0].id,first.project.segments[0].id);const emptySource=source();emptySource.scenes=[];emptySource.segments=[];assert.deepEqual(init(f,emptySource).project.segments,[]);emptySource.segments=[{name:'A',start_shot_id:null}];const alias=init(f,emptySource);assert.deepEqual(alias.project.segments,[]);assert.deepEqual(alias.project.segment_used_names,[]);});
