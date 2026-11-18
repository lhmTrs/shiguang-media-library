import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {legacyVideoLibrary} from './helpers/video-v2-legacy-library.mjs';
import {VideoBindingV2} from '../server/storyboard-video-v2/store.mjs';
import {upgradePolicy} from '../server/storyboard-video-v2/upgrade-policy.mjs';
import {hash} from '../server/storyboard-video-v2/model.mjs';

for(const policyExists of [false,true])test('stop during final policy IO preserves rows and resumes the original request: '+(policyExists?'existing policy':'ENOENT'),async t=>{
 const f=await legacyVideoLibrary(t);
 if(policyExists)await upgradePolicy({dataDir:f.lib.dataDir,instanceId:f.instanceId,mode:'automatic',reason:'synthetic normal upgrade'});
 const originalOpen=fs.open,checkpoint=f.v2.upgradeCheckpoint.bind(f.v2);let deleteStage=false,stoppedDuringRead=false;
 f.v2.upgradeCheckpoint=phase=>{checkpoint();if(phase==='delete')deleteStage=true;};
 fs.open=async function(file,...args){if(deleteStage&&String(file).endsWith('/upgrade-policy.json')){stoppedDuringRead=true;f.v2.beginClose();}return originalOpen.call(this,file,...args);};
 let result;try{result=await f.v2.startup();}finally{fs.open=originalOpen;}
 assert.equal(stoppedDuringRead,true);assert.deepEqual(f.v2.legacyRows(),f.legacy);assert.equal(result.status,'failed');assert.equal(result.reasonCode,'VIDEO_V2_UPGRADE_STOPPED');assert.equal(f.v2.schemaState().status,'pending');
 const file=path.join(f.lib.dataDir,'video-binding-v2','startup-'+hash(f.instanceId)+'.json'),journal=JSON.parse(await fs.readFile(file,'utf8'));
 assert.equal(journal.status,'failed');assert.equal(journal.phase,'delete');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM storyboard_video_v2_requests').get().n,0);assert.deepEqual(await fs.readFile(f.source.path),f.bytes);
 const restarted=new VideoBindingV2({videos:f.entry.store,instanceId:f.instanceId}).init();assert.equal((await restarted.startup()).status,'complete');const after=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(after.requestId,journal.requestId);assert.equal(after.exportHash,journal.exportHash);assert.equal(restarted.request(journal.requestId).status,'committed');
});

for(const stopAtLock of [false,true])test('migration execute boundary rejects a close '+(stopAtLock?'while acquiring its lock':'before direct execution'),async t=>{
 const f=await legacyVideoLibrary(t);f.v2.installSchema();const exported=await f.v2.exportLegacy(path.join(f.dir,'owned-export')),input=JSON.parse(await fs.readFile(exported.file,'utf8')),requestId=randomUUID(),before=f.v2.stateRow('migration');
 if(stopAtLock){const lock=f.assets.lockDirectory.bind(f.assets);t.mock.method(f.assets,'lockDirectory',()=>{lock();f.v2.beginClose();});}else f.v2.beginClose();
 assert.throws(()=>f.v2.executeMigration(input,{requestId}),{code:'VIDEO_V2_UPGRADE_STOPPED'});assert.deepEqual(f.v2.legacyRows(),f.legacy);assert.deepEqual(f.v2.stateRow('migration'),before);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM storyboard_video_v2_requests').get().n,0);
});

test('legacy project-video guards retain priority while migration protection remains unavailable',async t=>{
 const f=await legacyVideoLibrary(t),start=()=>f.catalog.start(f.a.id,{requestId:randomUUID(),fileName:'guarded.mp4',bytes:f.bytes.length}),env=process.env.MEDIA_READONLY_FILES,locks=f.board.generationLocks;
 try{
  f.entry.media.closing=true;await assert.rejects(start,{code:'VIDEO_BUSY'});f.entry.media.closing=false;
  f.lib.migrating=true;await assert.rejects(start,{code:'VIDEO_BUSY'});f.lib.migrating=false;
  process.env.MEDIA_READONLY_FILES='1';await assert.rejects(start,{code:'READONLY_FILES'});if(env===undefined)delete process.env.MEDIA_READONLY_FILES;else process.env.MEDIA_READONLY_FILES=env;
  f.board.generationLocks={assertWritable(){throw Object.assign(Error('owned generation lock'),{code:'FIXTURE_LOCKED'});}};await assert.rejects(start,{code:'FIXTURE_LOCKED'});f.board.generationLocks=locks;
  await assert.rejects(start,{code:'VIDEO_V2_MIGRATION_REQUIRED'});assert.deepEqual(f.v2.legacyRows(),f.legacy);
 }finally{f.entry.media.closing=false;f.lib.migrating=false;f.board.generationLocks=locks;if(env===undefined)delete process.env.MEDIA_READONLY_FILES;else process.env.MEDIA_READONLY_FILES=env;}
});

test('provider migration starting during final policy IO cannot enter the delete transaction',async t=>{
 const f=await legacyVideoLibrary(t),open=fs.open,checkpoint=f.v2.upgradeCheckpoint.bind(f.v2);let deleting=false;
 f.v2.upgradeCheckpoint=phase=>{checkpoint();if(phase==='delete')deleting=true;};fs.open=async function(file,...args){if(deleting&&String(file).endsWith('/upgrade-policy.json'))f.lib.migrating=true;return open.call(this,file,...args);};
 let result;try{result=await f.v2.startup();}finally{fs.open=open;f.lib.migrating=false;}
 assert.equal(result.status,'failed');assert.equal(result.reasonCode,'VIDEO_V2_UPGRADE_INSTANCE_CHANGED');assert.deepEqual(f.v2.legacyRows(),f.legacy);assert.equal(f.v2.schemaState().status,'pending');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM storyboard_video_v2_requests').get().n,0);
});
