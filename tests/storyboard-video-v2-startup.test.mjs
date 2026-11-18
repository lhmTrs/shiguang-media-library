import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {legacyVideoLibrary} from './helpers/video-v2-legacy-library.mjs';
import {upgradePolicy} from '../server/storyboard-video-v2/upgrade-policy.mjs';
import {hash} from '../server/storyboard-video-v2/model.mjs';
import {acquireUpgradeFileLock,privateDirectory} from '../server/storyboard-video-v2/upgrade-files.mjs';
const journalFile=f=>path.join(f.lib.dataDir,'video-binding-v2','startup-'+hash(f.instanceId)+'.json');
async function readableUnknown(f,status){
 const before=f.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'storyboard_video_v2_%'").get().n;
 const state=f.v2.state(f.a.id),list=await f.catalog.list(f.a.id),binding=f.v2.sourceBinding(f.a.id,f.video.videoId),page=f.v2.shotVideos(f.a.id,'shot_0');
 assert.equal(state.migration.status,status);assert.equal(state.migration.adoptionKnown,false);assert.equal(state.migration.historyPrune,'paused');assert.equal(state.context.selectionRevision,null);assert.equal(state.shots[0].candidateCount,null);assert.equal(state.shots[0].needsReview,null);
 assert.equal(list.videos.length,1);assert.equal(list.videos[0].adoptedShots,null);assert.equal(list.adoptionStamp,null);assert.equal(list.migration.writeAllowed,false);assert.equal(binding.bindingRevision,null);assert.equal(page.total,null);assert.equal(f.board.read(f.a.id).videoBindingMigration.historyPrune,'paused');
 await assert.rejects(()=>f.catalog.start(f.a.id,{requestId:randomUUID(),fileName:'blocked.mp4',bytes:f.bytes.length}),{code:'VIDEO_V2_MIGRATION_REQUIRED'});
 assert.throws(()=>f.v2.retainedVersionNumbers(f.board.head(f.a.id).id),{code:'VIDEO_V2_MIGRATION_REQUIRED'});
 assert.deepEqual(f.v2.legacyRows(),f.legacy);assert.deepEqual(await fs.readFile(f.source.path),f.bytes);assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'storyboard_video_v2_%'").get().n,before);
}
test('existing library reads remain honest before startup; automatic upgrade exports and completes exactly once',async t=>{
 const f=await legacyVideoLibrary(t);await readableUnknown(f,'schema-required');const result=await f.v2.startup();assert.equal(result.status,'complete');assert.equal(result.writeAllowed,true);assert.ok(Object.values(f.v2.legacyRows()).every(rows=>!rows.length));
 const first=JSON.parse(await fs.readFile(journalFile(f),'utf8'));assert.equal(first.status,'complete');const exported=JSON.parse(await fs.readFile(path.join(path.dirname(journalFile(f)),first.exportFile),'utf8'));assert.deepEqual(exported.tables,f.legacy);assert.equal(exported.checksum,first.exportHash);assert.equal(f.v2.request(first.requestId).status,'committed');
 assert.equal((await fs.stat(path.dirname(journalFile(f)))).mode&0o077,0);assert.equal((await fs.stat(path.join(path.dirname(journalFile(f)),first.exportFile))).mode&0o077,0);
 const before=await fs.readdir(path.dirname(journalFile(f)));assert.equal((await f.v2.startup()).status,'complete');assert.deepEqual(await fs.readdir(path.dirname(journalFile(f))),before);assert.deepEqual(await fs.readFile(f.source.path),f.bytes);assert.equal((await f.catalog.list(f.a.id)).videos.length,1);
});
test('instance-bound defer is read before schema/export/delete; wrong-instance and malformed policy fail closed',async t=>{
 const f=await legacyVideoLibrary(t);const policy=await upgradePolicy({dataDir:f.lib.dataDir,instanceId:f.instanceId,mode:'defer',reason:'合成库等待批准'});assert.equal((await f.v2.startup()).status,'deferred');await readableUnknown(f,'deferred');const dir=path.dirname(journalFile(f));assert.equal((await fs.readdir(dir)).some(n=>n.startsWith('legacy-')),false);assert.equal(f.v2.schemaState().status,'schema-required');
 await assert.rejects(()=>upgradePolicy({dataDir:f.lib.dataDir,instanceId:randomUUID(),mode:'automatic',reason:'wrong'}),{code:'VIDEO_V2_UPGRADE_INSTANCE_MISMATCH'});
 const file=path.join(dir,'upgrade-policy.json'),original=JSON.parse(await fs.readFile(file,'utf8'));await fs.writeFile(file,JSON.stringify({...original,instanceId:randomUUID()}));assert.equal((await f.v2.startup()).status,'failed');assert.equal(f.v2.migrationStatus().reasonCode,'VIDEO_V2_UPGRADE_INSTANCE_MISMATCH');assert.equal(f.v2.schemaState().status,'schema-required');
 await fs.writeFile(file,JSON.stringify(original));await upgradePolicy({dataDir:f.lib.dataDir,instanceId:f.instanceId,mode:'automatic',reason:'合成库明确许可',expectedPolicyId:policy.policy.policyId});assert.equal((await f.v2.startup()).status,'complete');
});
for(const phase of ['schema','export','check','delete'])test('interruption at '+phase+' preserves old rows, honest reads and same durable request on restart',async t=>{
 const f=await legacyVideoLibrary(t);let stopped=false;const original=f.v2.upgradeCheckpoint.bind(f.v2);f.v2.upgradeCheckpoint=async current=>{original();if(current===phase&&!stopped){stopped=true;throw Object.assign(Error('owned stage interruption'),{code:'VIDEO_V2_UPGRADE_TEST_INTERRUPTED'});}};
 assert.equal((await f.v2.startup()).status,'failed');assert.equal(f.v2.migrationStatus().phase,phase);await readableUnknown(f,'failed');const before=JSON.parse(await fs.readFile(journalFile(f),'utf8'));f.v2.upgradeCheckpoint=original;assert.equal((await f.v2.startup()).status,'complete');const after=JSON.parse(await fs.readFile(journalFile(f),'utf8'));assert.equal(after.requestId,before.requestId);if(before.exportFile)assert.equal(after.exportFile,before.exportFile);
});
test('partial deletes roll back marker and all rows; failed startup remains readable and retries the original verified export',async t=>{
 const f=await legacyVideoLibrary(t);f.db.exec("CREATE TRIGGER fail_startup BEFORE DELETE ON storyboard_video_plans BEGIN SELECT RAISE(ABORT,'owned delete interruption');END");assert.equal((await f.v2.startup()).status,'failed');assert.equal(f.v2.schemaState().status,'pending');await readableUnknown(f,'failed');const before=JSON.parse(await fs.readFile(journalFile(f),'utf8'));f.db.exec('DROP TRIGGER fail_startup');assert.equal((await f.v2.startup()).status,'complete');const after=JSON.parse(await fs.readFile(journalFile(f),'utf8'));assert.equal(after.exportHash,before.exportHash);assert.equal(after.requestId,before.requestId);
});
test('stale exported rows are never silently replaced with new input on restart',async t=>{
 const f=await legacyVideoLibrary(t);f.v2.upgradeCheckpoint=phase=>{if(phase==='delete')throw Error('owned stop');};await f.v2.startup();const before=JSON.parse(await fs.readFile(journalFile(f),'utf8'));f.db.prepare('UPDATE storyboard_video_takes SET import_order=2').run();f.v2.upgradeCheckpoint=()=>{};assert.equal((await f.v2.startup()).status,'failed');assert.equal(f.v2.migrationStatus().reasonCode,'VIDEO_V2_UPGRADE_EXPORT_STALE');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM storyboard_video_takes').get().n,1);assert.equal(JSON.parse(await fs.readFile(journalFile(f),'utf8')).exportHash,before.exportHash);
});
test('a live startup owner leaves reads available and never steals the instance lock',async t=>{
 const f=await legacyVideoLibrary(t),directory=await privateDirectory(path.join(f.lib.dataDir,'video-binding-v2')),release=await acquireUpgradeFileLock(directory,f.instanceId);try{assert.equal((await f.v2.startup()).status,'pending');assert.equal(f.v2.migrationStatus().reasonCode,'VIDEO_V2_UPGRADE_BUSY');await readableUnknown(f,'pending');}finally{await release();}assert.equal((await f.v2.startup()).status,'complete');
});
