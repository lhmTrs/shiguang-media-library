import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fixture,imported,finish,initialize,bind,replaceBytes} from './helpers/project-video-desktop-fixture.mjs';

const preview=async(f,s)=>finish(f,f.catalog.changes.preview(f.project.id,s.id,{requestId:randomUUID(),expectedRevision:f.catalog.metadata(f.project.id,s).row.revision}));
const removal=async(f,s)=>finish(f,f.catalog.changes.removePreview(f.project.id,s.id,{requestId:randomUUID(),expectedRevision:f.catalog.metadata(f.project.id,s).row.revision}));

test('D: changed current candidate is an owned snapshot, ordinary media remains guarded until explicit acceptance',async t=>{
  const f=await fixture(t),source=await imported(f);initialize(f);await bind(f,source);
  const before=f.entry.store.baseState(f.project.id);await replaceBytes(f,source);
  await assert.rejects(f.catalog.open(f.project.id,source.id),e=>e.code==='SOURCE_CHANGED');
  const p=await preview(f,source);assert.equal(p.status,'ready');assert.equal(p.before.oldContentAvailable,false);assert.equal(p.invalidAdoptedShots.length,0);
  const opened=await f.catalog.changes.open(f.project.id,source.id,p.contentToken);assert.notEqual(opened.path,source.path);await f.entry.media.release(opened.handle);
  const input={requestId:randomUUID(),expectedRevision:p.expectedRevision,adoptionStamp:p.adoptionStamp,contentToken:p.contentToken,confirmAcceptContent:true,confirmedUnbindShotIds:[]};
  const result=await finish(f,f.catalog.changes.accept(f.project.id,source.id,input));assert.equal(result.status,'completed');assert.equal(result.keptAdoptedShotIds.length,3);assert.deepEqual(f.entry.store.baseState(f.project.id).plan,before.plan);
  assert.deepEqual(f.catalog.changes.accept(f.project.id,source.id,input),result);
  const current=await f.catalog.open(f.project.id,source.id);await f.entry.media.release(current.handle);
  assert.equal(f.catalog.metadata(f.project.id,source).data.notes,'需要保留的备注');f.storyboards.validateBackup(f.storyboards.backup());
});

test('D: shorter replacement requires precise invalid-shot confirmation; historical takes stay but cannot be adopted',async t=>{
  const f=await fixture(t),source=await imported(f);initialize(f);await bind(f,source);
  const before=f.entry.store.baseState(f.project.id);await replaceBytes(f,source,{duration:1.5});const p=await preview(f,source);
  assert.equal(p.status,'ready');assert.equal(p.invalidAdoptedShots.length,2);
  const base={expectedRevision:p.expectedRevision,adoptionStamp:p.adoptionStamp,contentToken:p.contentToken,confirmAcceptContent:true};
  const bad=await finish(f,f.catalog.changes.accept(f.project.id,source.id,{...base,requestId:randomUUID(),confirmedUnbindShotIds:[]}));assert.equal(bad.code,'UNBIND_CONFIRMATION_REQUIRED');
  assert.deepEqual(f.entry.store.baseState(f.project.id).plan,before.plan);
  const result=await finish(f,f.catalog.changes.accept(f.project.id,source.id,{...base,requestId:randomUUID(),confirmedUnbindShotIds:p.invalidAdoptedShots.map(s=>s.id)}));assert.equal(result.status,'completed');assert.equal(result.unboundShotIds.length,2);
  const after=f.entry.store.baseState(f.project.id);assert.equal(Object.keys(after.plan.adopted).length,1);assert.deepEqual(after.takes,before.takes);assert.deepEqual(after.shots,before.shots);
  f.storyboards.validateBackup(f.storyboards.backup());
  const current=f.entry.store.current(f.project.id);assert.throws(()=>f.entry.store.savePlan(f.project.id,current,before.plan.adopted),e=>e.code==='INVALID_INTERVAL');
});

test('D: candidate edited after preview, stale record and changed adoption do not authorize new content',async t=>{
  const f=await fixture(t),source=await imported(f);initialize(f);await bind(f,source);await replaceBytes(f,source);const p=await preview(f,source);
  await replaceBytes(f,source,{color:'green'});
  const result=await finish(f,f.catalog.changes.accept(f.project.id,source.id,{requestId:randomUUID(),expectedRevision:p.expectedRevision,adoptionStamp:p.adoptionStamp,contentToken:p.contentToken,confirmAcceptContent:true,confirmedUnbindShotIds:[]}));
  assert.equal(result.status,'failed');assert.equal(f.catalog.metadata(f.project.id,source).row.revision,p.expectedRevision);assert.equal(Object.keys(f.entry.store.baseState(f.project.id).plan.adopted).length,3);
});

test('D: keep removal works with missing file and does not delete shot/dialogue or change file references elsewhere',async t=>{
  const f=await fixture(t),source=await imported(f);initialize(f);await bind(f,source);const before=f.entry.store.baseState(f.project.id);await fs.unlink(source.path);
  const p=await removal(f,source);assert.equal(p.status,'ready');assert.equal(p.canTrash,false);assert.equal(p.affectedAdoptedShots.length,3);
  const input={requestId:randomUUID(),expectedRevision:1,adoptionStamp:p.adoptionStamp,removalToken:p.removalToken,confirmUnbind:true,fileAction:'keep'};
  const result=await finish(f,f.catalog.changes.remove(f.project.id,source.id,input));assert.equal(result.status,'completed');assert.equal(result.file.status,'kept');assert.deepEqual(f.entry.store.baseState(f.project.id).shots,before.shots);assert.equal(Object.keys(f.entry.store.baseState(f.project.id).plan.adopted).length,0);assert.deepEqual(f.catalog.changes.remove(f.project.id,source.id,input),result);assert.equal(f.trash.length,0);
});

test('D: trash is explicit, staged and never replayed after a partial file failure',async t=>{
  const f=await fixture(t),source=await imported(f);initialize(f);await bind(f,source);const p=await removal(f,source);
  assert.equal(p.canTrash,true);let calls=0;f.catalog.fileOperations.trash=async()=>{calls++;throw Object.assign(Error('permission'),{code:'EACCES'});};
  const input={requestId:randomUUID(),expectedRevision:1,adoptionStamp:p.adoptionStamp,removalToken:p.removalToken,confirmUnbind:true,fileAction:'trash'};
  const result=await finish(f,f.catalog.changes.remove(f.project.id,source.id,input));assert.equal(result.status,'partial');assert.equal(result.record.removed,true);assert.equal(result.file.status,'failed');assert.equal(calls,1);await fs.access(source.path);assert.equal(Object.keys(f.entry.store.baseState(f.project.id).plan.adopted).length,0);assert.deepEqual(f.catalog.changes.remove(f.project.id,source.id,input),result);assert.equal(calls,1);
});

test('D: synthetic system trash success, other references and active preview block trash before metadata changes',async t=>{
  const f=await fixture(t),source=await imported(f),p=await removal(f,source),open=await f.catalog.open(f.project.id,source.id);
  const base={expectedRevision:1,adoptionStamp:p.adoptionStamp,removalToken:p.removalToken,confirmUnbind:true,fileAction:'trash'};
  const busy=await finish(f,f.catalog.changes.remove(f.project.id,source.id,{...base,requestId:randomUUID()}));assert.equal(busy.code,'VIDEO_IN_USE');assert.equal(f.catalog.metadata(f.project.id,source).data.removedAt,0);await f.entry.media.release(open.handle);
  const done=await finish(f,f.catalog.changes.remove(f.project.id,source.id,{...base,requestId:randomUUID()}));assert.equal(done.file.status,'trashed');assert.equal(f.trash.length,1);await assert.rejects(fs.access(source.path));
});
