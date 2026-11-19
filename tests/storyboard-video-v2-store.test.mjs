import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createStoryboardVideo} from '../server/storyboard-video/index.mjs';
import {V2_TABLES} from '../server/storyboard-video-v2/schema.mjs';
import {videoV2Fixture} from './helpers/video-binding-v2-fixture.mjs';

test('state is readonly, uninitialized is explicit, real raw imports bind current revision and retain old-shot timing',async t=>{
 const f=await videoV2Fixture(t);assert.equal(f.v2.state(f.a.id).initialized,false);f.initialize();const video=await f.imported();const before=f.board.backup().checksum;
 f.v2.state(f.a.id);assert.equal(f.board.backup().checksum,before);const bound=await f.bind(video.videoId);assert.equal(bound.binding.origin,'manual');assert.equal(bound.binding.provenance,null);assert.equal(bound.binding.shots[0].durationMs,1000);
 const state=f.v2.state(f.a.id);assert.equal(state.shots[0].defaultVideo.videoId,video.videoId);assert.equal(state.shots[0].adopted,null);assert.equal(state.shots[0].needsReview,false);
 const page=f.v2.shotVideos(f.a.id,'shot_0');assert.equal(page.items[0].status,'available');assert.match(page.items[0].mediaUrl,/api\/project-videos/);assert.ok(!JSON.stringify(state).includes(f.dir));assert.ok(!JSON.stringify(page).includes(f.dir));assert.deepEqual(await fs.readFile(f.file),f.bytes);
});
test('new-video count uses association sequence after actual selection; bulk/single adoption, clear-video and noop preserve event order',async t=>{
 const f=await videoV2Fixture(t);f.initialize();const a=await f.imported(),b=await f.imported();await f.bind(a.videoId);await f.bind(b.videoId);f.select(a.videoId);assert.equal(f.v2.state(f.a.id).shots[0].newVideoCount,0);
 const c=await f.imported();await f.bind(c.videoId);assert.equal(f.v2.state(f.a.id).shots[0].newVideoCount,1);assert.equal(f.v2.state(f.a.id).shots[0].adopted.videoId,a.videoId);
 f.select(b.videoId,{action:'adopt-shot',shotId:'shot_0'});assert.equal(f.v2.state(f.a.id).shots[0].newVideoCount,0);f.select(a.videoId,{action:'clear-video'});
 const current=f.v2.state(f.a.id);assert.equal(current.shots[0].adopted.videoId,b.videoId);assert.equal(current.shots[1].adopted,null);
 const prior=f.v2.sourceBinding(f.a.id,b.videoId);await f.bind(b.videoId);assert.equal(f.v2.sourceBinding(f.a.id,b.videoId).bindingRevision,prior.bindingRevision);
 const sequence=f.v2.stateRow('global').sequence;f.select(b.videoId,{action:'adopt-shot',shotId:'shot_0'});assert.equal(f.v2.stateRow('global').sequence,sequence);
});
test('immutable generation provenance is reserved before import; upload registers and auto-binds in the original transaction',async t=>{
 const f=await videoV2Fixture(t);f.initialize();const view=f.board.read(f.a.id),input={requestId:randomUUID(),expectedStoryboardRevision:view.revision,expectedAssetStamp:view.asset_stamp,shotIds:['shot_0','shot_1']},reserved=await f.v2.reserve(f.a.id,input);assert.equal((await f.v2.reserve(f.a.id,input)).repeated,true);
 const changed=structuredClone(view.project);changed.scenes[0].shots[0].action='等待时改稿';f.board.save(f.a.id,{project:changed,expected_revision:view.revision});
 const video=await f.imported({storyboardOrigin:{provenanceId:reserved.provenance.provenanceId,expectedProvenanceRevision:1}});assert.equal(video.status,'ready');assert.equal(video.binding.status,'bound');assert.equal(video.binding.storyboardRevision,view.revision);
 const binding=f.v2.sourceBinding(f.a.id,video.videoId);assert.equal(binding.binding.origin,'agent');assert.equal(binding.binding.provenance.inputHash,reserved.provenance.inputHash);assert.equal(binding.review.needsReview,true);
 assert.equal(f.v2.provenance(reserved.provenance.provenanceId).status,'bound');assert.throws(()=>f.v2.release(reserved.provenance.provenanceId,{requestId:randomUUID(),expectedProvenanceRevision:2,reason:'failed'}),{code:'VIDEO_ORIGIN_CONFLICT'});
 assert.ok(f.v2.retainedVersionNumbers(view.project.document_id).has(view.revision));
});
test('review confirms seen dependencies, changes mark again, undo reverts baseline; stale hash conflicts leave prior review intact',async t=>{
 const f=await videoV2Fixture(t);f.initialize();const video=await f.imported();await f.bind(video.videoId);const view=f.board.read(f.a.id),draft=structuredClone(view.project);draft.scenes[0].shots[0].camera='推近';f.board.save(f.a.id,{project:draft,expected_revision:view.revision});
 const previous=f.v2.sourceBinding(f.a.id,video.videoId),request={requestId:randomUUID(),action:'confirm',expectedBindingRevision:previous.bindingRevision,seenStoryboardRevision:previous.context.storyboardRevision,expectedComparisonHash:previous.review.comparisonHash};const reviewed=await f.v2.review(f.a.id,video.videoId,request);assert.equal(reviewed.review.needsReview,false);assert.equal(reviewed.review.reviewedToRevision,2);assert.equal((await f.v2.review(f.a.id,video.videoId,request)).repeated,true);
 const master=f.assets.get(draft.characters[0].id);master.performance_info='修改人物信息';await f.assets.save(master.id,master,master.revision);assert.equal(f.board.read(f.a.id).revision,2);
 const changed=f.v2.sourceBinding(f.a.id,video.videoId);assert.equal(changed.review.needsReview,true);await assert.rejects(()=>f.v2.review(f.a.id,video.videoId,{...request,requestId:randomUUID(),expectedBindingRevision:changed.bindingRevision,expectedComparisonHash:reviewed.review.comparisonHash}),{code:'VIDEO_REVIEW_CONFLICT'});
 const undone=await f.v2.review(f.a.id,video.videoId,{requestId:randomUUID(),action:'undo',expectedBindingRevision:changed.bindingRevision,seenStoryboardRevision:2,expectedComparisonHash:changed.review.comparisonHash});assert.equal(undone.review.reviewedToRevision,null);assert.equal(undone.review.needsReview,true);
});
test('bindings and selections compare preview dependencies and persist exact replay/rejection receipts',async t=>{
 const f=await videoV2Fixture(t);f.initialize();const video=await f.imported(),view=f.board.read(f.a.id),intent={action:'bind',expectedBindingRevision:0,targetProjectId:f.a.id,expectedStoryboardRevision:1,expectedAssetStamp:view.asset_stamp,shotIds:['shot_0']},preview=await f.v2.previewBinding(f.a.id,video.videoId,intent),input={...intent,requestId:randomUUID(),previewHash:preview.previewHash};
 await f.bind(video.videoId,['shot_1']);await assert.rejects(()=>f.v2.bind(f.a.id,video.videoId,input),{code:'VIDEO_BINDING_CONFLICT'});assert.equal(f.v2.request(input.requestId).status,'rejected');await assert.rejects(()=>f.v2.bind(f.a.id,video.videoId,{...input,shotIds:['shot_1']}),{code:'REQUEST_ID_CONFLICT'});
 const original=f.v2.sourceBinding(f.a.id,video.videoId);await assert.rejects(()=>f.v2.bind(f.a.id,video.videoId,{...input,requestId:randomUUID(),review:{confirm:true}}),{code:'VIDEO_V2_INVALID_INPUT'});assert.equal(f.v2.sourceBinding(f.a.id,video.videoId).bindingRevision,original.bindingRevision);
});

test('pin provider retains reserved, original binding and review versions beyond the normal 50-version horizon',async t=>{
 const f=await videoV2Fixture(t);f.initialize();const view=f.board.read(f.a.id),reserved=await f.v2.reserve(f.a.id,{requestId:randomUUID(),expectedStoryboardRevision:1,expectedAssetStamp:view.asset_stamp,shotIds:['shot_0']});
 const video=await f.imported({storyboardOrigin:{provenanceId:reserved.provenance.provenanceId,expectedProvenanceRevision:1}});
 let current=f.board.read(f.a.id),project=structuredClone(current.project);project.scenes[0].shots[0].camera='推近';f.board.save(f.a.id,{project,expected_revision:1});
 const seen=f.v2.sourceBinding(f.a.id,video.videoId);await f.v2.review(f.a.id,video.videoId,{requestId:randomUUID(),action:'confirm',expectedBindingRevision:seen.bindingRevision,seenStoryboardRevision:2,expectedComparisonHash:seen.review.comparisonHash});
 current=f.board.read(f.a.id);project=structuredClone(current.project);project.scenes[0].shots[0].action='新的动作';f.board.save(f.a.id,{project,expected_revision:2});await f.bind(video.videoId,['shot_0']);
 for(let i=0;i<54;i++){const current=f.board.read(f.a.id),project=structuredClone(current.project);project.scenes[0].shots[0].action='第'+i+'次合成变化';f.board.save(f.a.id,{project,expected_revision:current.revision});}
 for(const version of [1,2,3]){assert.ok(f.v2.retainedVersionNumbers(view.project.document_id).has(version));assert.notEqual(f.board.history.row(view.project.document_id,version).document_json,null);}
 assert.equal(f.board.history.row(view.project.document_id,4).document_json,null,'unreferenced old snapshots still prune');
 const full=f.db.prepare('SELECT COUNT(*) n FROM storyboard_versions WHERE document_json IS NOT NULL').get().n;
 f.db.prepare('UPDATE storyboard_video_v2_state SET data_json=? WHERE id=?').run(JSON.stringify({schemaVersion:1,status:'unknown'}),'migration');
 current=f.board.read(f.a.id);project=structuredClone(current.project);project.scenes[0].shots[0].camera='无法核验时保留';const saved=f.board.save(f.a.id,{project,expected_revision:current.revision});assert.equal(saved.history_cleanup,'failed');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM storyboard_versions WHERE document_json IS NOT NULL').get().n,full+1);
 f.db.prepare('UPDATE storyboard_video_v2_state SET data_json=? WHERE id=?').run(JSON.stringify({schemaVersion:1,status:'complete'}),'migration');f.db.exec('ALTER TABLE storyboard_video_v2_provenance ADD COLUMN future_unknown TEXT');current=f.board.read(f.a.id);project=structuredClone(current.project);project.scenes[0].shots[0].camera='未知表结构保留';assert.equal(f.board.save(f.a.id,{project,expected_revision:current.revision}).history_cleanup,'failed');
});

test('origin confirmation rechecks its original ready receipt and original import retry survives bound provenance revision',async t=>{
 const f=await videoV2Fixture(t);f.initialize();const view=f.board.read(f.a.id),reserved=await f.v2.reserve(f.a.id,{requestId:randomUUID(),expectedStoryboardRevision:1,expectedAssetStamp:view.asset_stamp,shotIds:['shot_0']}),origin={provenanceId:reserved.provenance.provenanceId,expectedProvenanceRevision:1},video=await f.imported({storyboardOrigin:origin});
 const receipt=f.catalog.receipt(f.a.id,video.id),request={requestId:randomUUID(),provenanceId:origin.provenanceId,expectedProvenanceRevision:1,expectedBindingRevision:1,importRequestId:receipt.id};
 assert.equal((await f.v2.recordOrigin(f.a.id,video.videoId,request)).binding.status,'bound');await assert.rejects(()=>f.v2.recordOrigin(f.a.id,video.videoId,{...request,requestId:randomUUID(),importRequestId:randomUUID()}),{code:'VIDEO_ORIGIN_CONFLICT'});
 const again=await f.catalog.start(f.a.id,{requestId:receipt.id,fileName:receipt.fileName,bytes:receipt.bytes,prompt:{mode:'none'},storyboardOrigin:origin});assert.equal(again.status,'ready');assert.equal(again.videoId,video.videoId);
});

test('an existing project library never installs v2 automatically merely because old source tables were absent',async t=>{
 const f=await videoV2Fixture(t);for(const table of Object.keys(V2_TABLES))f.db.exec('DROP TABLE '+table);f.db.exec('DROP TABLE storyboard_video_sources');const newEntry=createStoryboardVideo({lib:f.lib,storyboards:f.board,media:f.entry.media,instanceId:'synthetic-instance'});assert.equal(newEntry.bindingV2.schemaState().status,'schema-required');assert.equal(newEntry.bindingV2.state(f.a.id).migration.status,'schema-required');assert.equal(newEntry.bindingV2.state(f.a.id).migration.adoptionKnown,false);newEntry.bindingV2.installSchema();assert.equal(newEntry.bindingV2.schemaState().status,'pending');assert.throws(()=>newEntry.bindingV2.retainedVersionNumbers(randomUUID()),{code:'VIDEO_V2_MIGRATION_REQUIRED'});
});

test('explicit release drops an unused pin; reinitialization leaves old bindings historical and project deletion protected',async t=>{
 const f=await videoV2Fixture(t);f.initialize();const first=f.board.read(f.a.id),reserved=await f.v2.reserve(f.a.id,{requestId:randomUUID(),expectedStoryboardRevision:1,expectedAssetStamp:first.asset_stamp,shotIds:['shot_0']});assert.ok(f.v2.retainedVersionNumbers(first.project.document_id).has(1));f.v2.release(reserved.provenance.provenanceId,{requestId:randomUUID(),expectedProvenanceRevision:1,reason:'not-submitted'});assert.equal(f.v2.retainedVersionNumbers(first.project.document_id).has(1),false);
 const video=await f.imported();await f.bind(video.videoId);f.select(video.videoId);f.initialize();const current=f.v2.state(f.a.id),old=f.v2.sourceBinding(f.a.id,video.videoId);assert.equal(current.shots[0].defaultVideo,null);assert.equal(current.shots[0].adopted,null);assert.equal(old.review.canReview,false);assert.equal(old.review.disabledReason,'STORYBOARD_GENERATION_CHANGED');assert.equal(old.binding.shots[0].existsInCurrent,false);assert.ok(f.v2.retainedVersionNumbers(first.project.document_id).has(1));assert.ok(f.board.validateBackup(f.board.backup()));assert.throws(()=>f.projects.remove(f.a.id));
});
