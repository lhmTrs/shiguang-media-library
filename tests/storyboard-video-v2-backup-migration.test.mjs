import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {videoV2Fixture} from './helpers/video-binding-v2-fixture.mjs';
import {canonical,digest} from '../server/project-assets/model.mjs';
import {hash} from '../server/storyboard-video-v2/model.mjs';

async function legacy(f){
 f.initialize();const video=await f.imported(),current=f.entry.store.current(f.a.id),take=randomUUID(),request=randomUUID(),now=Date.now(),data={segments:[{sourceId:video.videoId,inMs:0,outMs:1000}],alignment:'estimated',timingHash:current.timingHash};
 f.db.prepare('INSERT INTO storyboard_video_takes VALUES(?,?,?,?,?,?,?,?,?)').run(take,f.a.id,current.documentId,current.initializedAt,'shot_0',1,canonical(data),now,now);
 f.db.prepare('INSERT INTO storyboard_video_plans VALUES(?,?,?,?,?,?,?,?)').run(f.a.id,current.documentId,current.initializedAt,1,current.timingHash,canonical({adopted:{shot_0:take}}),now,now);
 f.db.prepare('INSERT INTO storyboard_video_requests VALUES(?,?,?,?,?,?,?,?)').run(request,f.a.id,current.documentId,current.initializedAt,'a'.repeat(64),canonical({receipt:{requestId:request,planRevision:1,takeIds:[take],sourceIds:[video.videoId],adoptedShotIds:['shot_0']},before:{}}),now,now);
 f.v2.markLegacyRestored();return video;
}
test('migration exports/reads private rows, interrupted DELETE rolls back, execute and restore are exact and idempotent; sources/files unchanged',async t=>{
 const f=await videoV2Fixture(t),video=await legacy(f),source=f.entry.store.source(f.a.id,video.videoId),raw=f.v2.legacyRows();assert.equal(f.v2.state(f.a.id).migration.status,'pending');assert.equal(f.v2.state(f.a.id).shots[0].candidateCount,null);
 const exported=await f.v2.exportLegacy(path.join(f.dir,'private-export')),saved=JSON.parse(await fs.readFile(exported.file,'utf8'));assert.deepEqual(saved.tables,raw);assert.equal((await fs.stat(exported.file)).mode&0o077,0);assert.equal(f.v2.checkMigration(saved).exportMatches,true);
 f.db.exec("CREATE TRIGGER fail_old_delete BEFORE DELETE ON storyboard_video_plans BEGIN SELECT RAISE(ABORT,'owned migration interruption');END");assert.throws(()=>f.v2.executeMigration(saved,{requestId:randomUUID()}),/owned migration interruption/);assert.deepEqual(f.v2.legacyRows(),raw);assert.equal(f.v2.schemaState().status,'pending');f.db.exec('DROP TRIGGER fail_old_delete');
 const input={requestId:randomUUID()},done=f.v2.executeMigration(saved,input);assert.equal(done.status,'complete');assert.equal(f.v2.executeMigration(saved,input).repeated,true);assert.ok(Object.values(f.v2.legacyRows()).every(rows=>rows.length===0));assert.equal(f.v2.request(input.requestId).status,'committed');
 assert.deepEqual(f.entry.store.source(f.a.id,video.videoId),source);assert.deepEqual(await fs.readFile(source.path),f.bytes);
 const restoredId=randomUUID(),restored=f.v2.restoreLegacy(saved,{requestId:restoredId});assert.equal(restored.status,'pending');assert.equal(f.v2.request(restoredId).status,'committed');assert.deepEqual(f.v2.legacyRows(),raw);assert.deepEqual(JSON.parse(await fs.readFile(exported.file,'utf8')),saved);
});
test('migration refuses damaged exports, stale row sets and files in a non-private directory',async t=>{
 const f=await videoV2Fixture(t);await legacy(f);const output=await f.v2.exportLegacy(path.join(f.dir,'private')),saved=JSON.parse(await fs.readFile(output.file,'utf8')),bad=structuredClone(saved);bad.tables.storyboard_video_takes[0].project_id=f.b.id;const {checksum,...body}=bad;bad.checksum=hash(body);assert.throws(()=>f.v2.checkMigration(bad),{code:'VIDEO_V2_INVALID_INPUT'});
 f.db.prepare('UPDATE storyboard_video_takes SET import_order=2').run();assert.throws(()=>f.v2.executeMigration(saved,{requestId:randomUUID()}),{code:'VIDEO_BINDING_CONFLICT'});assert.equal(f.v2.schemaState().status,'pending');
 const directory=path.join(f.dir,'public');await fs.mkdir(directory,{mode:0o755});await assert.rejects(f.v2.exportLegacy(directory),{code:'VIDEO_V2_INVALID_INPUT'});
});
test('v2 backup includes authoritative identities, pins, immutable origins, reviews and request receipts; corrupt payload and partial restore roll back',async t=>{
 const f=await videoV2Fixture(t);f.initialize();const view=f.board.read(f.a.id),reserved=await f.v2.reserve(f.a.id,{requestId:randomUUID(),expectedStoryboardRevision:1,expectedAssetStamp:view.asset_stamp,shotIds:['shot_0','shot_1']}),video=await f.imported({storyboardOrigin:{provenanceId:reserved.provenance.provenanceId,expectedProvenanceRevision:1}});f.select(video.videoId);
 const backup=f.board.backup();assert.ok(backup.video_preview.video_binding_v2.tables.storyboard_video_v2_requests.length>=3);assert.ok(f.board.validateBackup(backup));
 const bad=structuredClone(backup),row=bad.video_preview.video_binding_v2.tables.storyboard_video_v2_bindings[0],snapshot=JSON.parse(row.snapshot_json);snapshot.context.projectId=f.b.id;row.snapshot_json=canonical(snapshot);bad.checksum=digest({tables:bad.tables,creative:bad.creative,change_history:bad.change_history,video_preview:bad.video_preview});assert.throws(()=>f.board.validateBackup(bad),{code:'VIDEO_V2_UNSETTLED'});
 const forged=structuredClone(backup),origin=forged.video_preview.video_binding_v2.tables.storyboard_video_v2_provenance[0],fake=JSON.parse(origin.snapshot_json);fake.shots[0].shotId='forged_nonexistent';fake.shotIds[0]='forged_nonexistent';const {inputHash:ignored,...body}=fake;fake.inputHash=hash(body);origin.snapshot_json=canonical(fake);origin.shot_ids_json=canonical(fake.shotIds);origin.input_hash=fake.inputHash;forged.checksum=digest({tables:forged.tables,creative:forged.creative,change_history:forged.change_history,video_preview:forged.video_preview});assert.throws(()=>f.board.validateBackup(forged),{code:'VIDEO_V2_UNSETTLED'});
 const g=await videoV2Fixture(t);g.projects.remove(g.a.id);g.projects.remove(g.b.id);const before=g.board.backup().checksum;
 g.db.exec("CREATE TRIGGER fail_v2_restore BEFORE INSERT ON storyboard_video_v2_shots BEGIN SELECT RAISE(ABORT,'owned v2 restore interruption');END");await assert.rejects(g.board.restore(backup),/owned v2 restore interruption/);assert.equal(g.board.backup().checksum,before);g.db.exec('DROP TRIGGER fail_v2_restore');
 await g.board.restore(backup);const binding=g.v2.sourceBinding(f.a.id,video.videoId);assert.equal(binding.binding.provenance.inputHash,reserved.provenance.inputHash);assert.equal(binding.review.canReview,false);assert.equal(binding.review.disabledReason,'VIDEO_UNVERIFIED');assert.ok(g.v2.retainedVersionNumbers(view.project.document_id).has(1));
});
