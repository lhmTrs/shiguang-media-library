import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture, imported, initialize, bind} from './helpers/project-video-desktop-fixture.mjs';

// Independent acceptance: all media, SQLite and injected trash belong to fixture(t).
// Faults are injected at actual IO/transaction boundaries, not in the move loop.
const folder = (f, name, parentId = 'root') => f.catalog.folders.create(f.project.id, {requestId: randomUUID(), name, parentId});
const confirmation = p => ({requestId: p.requestId, previewHash: p.previewHash, confirmUnbind: true, confirmedUnbindShotIds: p.affectedShots.map(s => s.id)});
const plan = (f, input) => f.catalog.fileOperations.preview(f.project.id, {
  requestId: randomUUID(), expectedRolesRevision: f.catalog.folders.roleState(f.project.id).revision, ...input,
});
async function finish(f, p) {
  await f.catalog.fileOperations.execute(f.project.id, confirmation(p));
  await f.catalog.queue;
  await new Promise(resolve => setImmediate(resolve));
  const s = f.catalog.fileOperations.row(f.project.id, p.requestId);
  return f.catalog.fileOperations.dto(p.requestId, s);
}
async function rolePlan(f, input) {
  return f.catalog.rejectArea.preview(f.project.id, {requestId: randomUUID(), expectedRolesRevision: f.catalog.folders.roleState(f.project.id).revision, ...input});
}
async function roleFinish(f, p) {
  await f.catalog.rejectArea.execute(f.project.id, {...confirmation(p), confirmRoleChange: true});
  await f.catalog.rejectArea.active.get(p.requestId);
  return f.catalog.rejectArea.dto(p.requestId, f.catalog.rejectArea.row(f.project.id, p.requestId));
}
async function setRole(f, folderId) {
  const done = await roleFinish(f, await rolePlan(f, {folderId}));
  assert.equal(done.status, 'ready', done.error);
  return done;
}
const present = file => fs.lstat(file).then(() => true, e => e.code === 'ENOENT' ? false : Promise.reject(e));
const source = (f, s) => f.entry.store.source(f.project.id, s.id);
const base = f => f.entry.store.baseState(f.project.id);

test('independent: committed move survives a lost transaction acknowledgement with durable READY', async t => {
  const f = await fixture(t); initialize(f);
  const area = await folder(f, '收纳处'); await setRole(f, area.id);
  const a = await imported(f, 'ack.mp4'); await bind(f, a, [0]);
  const p = await plan(f, {kind: 'move-videos', sourceIds: [a.id], destinationFolderId: area.id, unbindAdoptions: true});
  const tx = f.entry.store.tx.bind(f.entry.store); let committed = false;
  const mock = t.mock.method(f.entry.store, 'tx', fn => {
    const value = tx(fn);
    if (!committed) { committed = true; throw Error('independent: COMMIT succeeded, acknowledgement lost'); }
    return value;
  });
  const done = await finish(f, p); mock.mock.restore();
  const durable = f.catalog.fileOperations.row(f.project.id, p.requestId);
  t.diagnostic(JSON.stringify({status: done.status, durable: durable.status, error: done.error, adoptionCount: Object.keys(base(f).plan.adopted).length, oldExists: await present(a.path), newExists: await present(source(f, a).path)}));
  assert.ok(committed); assert.equal(source(f, a).path, path.join(area.path, a.name));
  assert.deepEqual(base(f).plan.adopted, {});
  assert.equal(done.status, 'ready', 'A committed ready journal must be read back, not overwritten UNKNOWN');
  assert.equal(durable.status, 'ready');
});

test('independent: recovery after lost COMMIT ACK must never reverse already committed bytes', async t => {
  const f = await fixture(t); initialize(f);
  const area = await folder(f, '收纳处'); await setRole(f, area.id);
  const a = await imported(f, 'recovery.mp4'); await bind(f, a, [0]);
  const p = await plan(f, {kind: 'move-videos', sourceIds: [a.id], destinationFolderId: area.id, unbindAdoptions: true});
  const tx = f.entry.store.tx.bind(f.entry.store); let lost = false;
  const mock = t.mock.method(f.entry.store, 'tx', fn => {const value = tx(fn); if (!lost) {lost = true; throw Error('independent: lost committed ACK');} return value;});
  await finish(f, p); mock.mock.restore();
  const committedPath = source(f, a).path;
  let result, error;
  try {result = await f.catalog.fileOperations.recover(f.project.id, p.requestId, {action: 'rollback'});} catch (e) {error = e;}
  t.diagnostic(JSON.stringify({recoveryError: error?.message, resultStatus: result?.status, recordStillPointsToCommittedPath: source(f, a).path === committedPath, committedPathExists: await present(committedPath), oldPathExists: await present(a.path), adopted: base(f).plan.adopted}));
  assert.equal(await present(committedPath), true, 'Recovery must not move a committed source back while metadata still points into reject area');
  assert.equal(await present(a.path), false); assert.equal(error, undefined); assert.equal(result.status, 'ready');
});

test('independent: failed READY journal write rolls metadata and moved bytes back together', async t => {
  const f = await fixture(t); initialize(f);
  const area = await folder(f, '收纳处'); await setRole(f, area.id);
  const a = await imported(f, 'ready-write.mp4'); await bind(f, a, [0]);
  const before = base(f).plan, p = await plan(f, {kind: 'move-videos', sourceIds: [a.id], destinationFolderId: area.id, unbindAdoptions: true});
  const save = f.catalog.fileOperations.save.bind(f.catalog.fileOperations); let rejected = false;
  const mock = t.mock.method(f.catalog.fileOperations, 'save', (id, requestId, s) => {
    if (!rejected && requestId === p.requestId && s.status === 'ready') {rejected = true; throw Error('independent: READY persistence rejected before COMMIT');}
    return save(id, requestId, s);
  });
  const done = await finish(f, p); mock.mock.restore();
  assert.deepEqual(base(f).plan, before); assert.equal(source(f, a).path, a.path);
  t.diagnostic(JSON.stringify({status: done.status, error: done.error, originalExists: await present(a.path), destinationExists: await present(path.join(area.path, a.name)), metadataUnchanged: source(f, a).path === a.path}));
  assert.ok(rejected); assert.equal(done.status, 'failed', 'Known metadata rollback must run the filesystem rollback');
  assert.equal(await present(a.path), true); assert.equal(await present(path.join(area.path, a.name)), false);
});

test('independent: move input cannot borrow delete mode to retire moving source IDs', async t => {
  const f = await fixture(t); initialize(f);
  const area = await folder(f, '收纳处'); await setRole(f, area.id);
  const a = await imported(f, 'mode.mp4'); await bind(f, a, [0]);
  let p;
  try {p = await plan(f, {kind: 'move-videos', sourceIds: [a.id], destinationFolderId: area.id, unbindAdoptions: true, mode: 'trash'});}
  catch (e) {assert.ok(e.status >= 400 && e.status < 500); assert.equal(f.catalog.metadata(f.project.id, source(f, a)).data.removedAt, 0); return;}
  const done = await finish(f, p), current = source(f, a), meta = f.catalog.metadata(f.project.id, current).data;
  t.diagnostic(JSON.stringify({status: done.status, removed: meta.removedAt > 0, authorized: f.entry.store.authorized(current), exists: await present(current.path), injectedTrashCalls: f.trash.length}));
  assert.equal(done.status, 'ready', done.error);
  assert.equal(meta.removedAt, 0, 'Moving sources must only detach, never retire, regardless of unrelated input fields');
  assert.equal(f.entry.store.authorized(current), true);
});

test('independent: real link failure reports the failed item separately from rolled-back predecessors', async t => {
  const f = await fixture(t), area = await folder(f, '收纳处'); await setRole(f, area.id);
  const a = await imported(f, 'a.mp4'), b = await imported(f, 'b.mp4'), c = await imported(f, 'c.mp4');
  const p = await plan(f, {kind: 'move-videos', sourceIds: [a.id, b.id, c.id], destinationFolderId: area.id, unbindAdoptions: true});
  const link = fs.link.bind(fs), calls = [];
  const mock = t.mock.method(fs, 'link', async (from, to) => {calls.push(path.basename(from)); if (from === b.path) throw Object.assign(Error('independent: no space for second link'), {code: 'ENOSPC'}); return link(from, to);});
  const done = await finish(f, p); mock.mock.restore();
  for (const s of [a, b, c]) {assert.equal(await present(s.path), true); assert.equal(await present(path.join(area.path, s.name)), false);}
  assert.deepEqual(calls, ['a.mp4', 'b.mp4']);
  assert.equal((await finish(f, p)).status, 'failed'); assert.equal(calls.length, 2);
  t.diagnostic(JSON.stringify({status: done.status, items: done.items.map(s => s.status), error: done.error}));
  assert.deepEqual(done.items.map(s => s.status), ['rolled-back', 'failed', 'not-run']);
});

test('independent: role creation reads a committed READY receipt after the identical ACK fault', async t => {
  const f = await fixture(t), p = await rolePlan(f, {create: {parentId: 'root', name: '收纳处'}});
  const tx = f.entry.store.tx.bind(f.entry.store); let lost = false;
  const mock = t.mock.method(f.entry.store, 'tx', fn => {const value = tx(fn); if (!lost) {lost = true; throw Error('independent: lost committed ACK');} return value;});
  const done = await roleFinish(f, p); mock.mock.restore();
  assert.equal(done.status, 'ready', done.error); assert.equal(done.folderId, p.roleChange.afterFolderId);
  assert.equal(await present(path.join(await f.catalog.folders.rootPath(f.project.id), '收纳处')), true);
});

test('independent: batch rejects malformed, missing, foreign and aliased source identities before moving', async t => {
  const f = await fixture(t), area = await folder(f, '收纳处'); await setRole(f, area.id);
  const a = await imported(f, 'a.mp4'), b = await imported(f, 'b.mp4');
  const foreign = await imported({...f, project: f.other}, 'foreign.mp4');
  const input = {kind: 'move-videos', destinationFolderId: area.id, unbindAdoptions: true};
  const operations = () => f.lib.db.prepare('SELECT COUNT(*) n FROM project_video_operations').get().n;
  const count = operations();
  for (const ids of [[], null, 'one', [null], [17], [''], [a.id, a.id], Array.from({length: 51}, () => randomUUID())]) {
    await assert.rejects(plan(f, {...input, sourceIds: ids}), e => e.code === 'INVALID_SOURCE_IDS');
  }
  for (const id of [foreign.id, randomUUID()]) {
    await assert.rejects(plan(f, {...input, sourceIds: [a.id, id]}), e => e.code === 'SOURCE_NOT_FOUND');
  }
  assert.equal(operations(), count); assert.equal(await present(a.path), true);
  // Two legitimate synthetic catalog records can refer to one hard-linked inode.
  await fs.unlink(b.path); await fs.link(a.path, b.path);
  const st = await fs.lstat(b.path), identity = {dev: String(st.dev), ino: String(st.ino), size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs};
  f.entry.store.tx(() => f.catalog.relocateRecord(f.project.id, b, b.path, identity));
  await assert.rejects(plan(f, {...input, sourceIds: [a.id, b.id]}), e => e.code === 'DUPLICATE_SOURCE');
  assert.equal(operations(), count); assert.equal(await present(a.path), true); assert.equal(await present(b.path), true);
});

test('independent: all 50 permitted sources move as one confirmed metadata batch and retain IDs', async t => {
  const f = await fixture(t), area = await folder(f, '收纳处'); await setRole(f, area.id);
  const sources = [];
  for (let n = 0; n < 50; n++) sources.push(await imported(f, `fifty-${n}.mp4`));
  const p = await plan(f, {kind: 'move-videos', sourceIds: sources.map(s => s.id), destinationFolderId: area.id, unbindAdoptions: true});
  assert.equal(p.willUnbindAdoptions, true); assert.equal(p.destinationFolderId, area.id);
  assert.equal(typeof p.adoptionStamp, 'string'); assert.deepEqual(p.affectedShots, []);
  for (const extra of [{confirmedUnbindShotIds: undefined}, {confirmedUnbindShotIds: [randomUUID()]}, {confirmUnbind: false}]) {
    await assert.rejects(f.catalog.fileOperations.execute(f.project.id, {...confirmation(p), ...extra}), e => e.code === 'UNBIND_CONFIRMATION_REQUIRED');
  }
  const done = await finish(f, p); assert.equal(done.status, 'ready', done.error); assert.equal(done.items.length, 50);
  for (const s of sources) {
    const current = source(f, s); assert.equal(current.id, s.id); assert.equal(current.path, path.join(area.path, s.name));
    assert.equal(f.catalog.metadata(f.project.id, current).data.removedAt, 0); assert.equal(f.catalog.isManaged(f.project.id, current), true);
    assert.equal(await present(s.path), false); assert.deepEqual(await fs.readFile(current.path), f.bytes);
  }
  assert.equal(f.catalog.folders.roleState(f.project.id).rejectVideoCount, 50);
  assert.equal((await f.catalog.list(f.project.id, {folderId: 'all'})).videos.length, 0);
  assert.equal((await f.catalog.list(f.project.id, {folderId: 'all', includeRejected: true})).videos.length, 50);
});

test('independent: case-folded same-batch destinations cannot overwrite one another', async t => {
  const f = await fixture(t), left = await folder(f, '甲'), right = await folder(f, '乙'), area = await folder(f, '收纳处'); await setRole(f, area.id);
  const a = await imported(f, 'Case.mp4', left.id), b = await imported(f, 'case.mp4', right.id);
  const input = {kind: 'move-videos', sourceIds: [a.id, b.id], destinationFolderId: area.id, unbindAdoptions: true};
  await assert.rejects(plan(f, {...input, choices: {[b.id]: 'overwrite'}}), e => e.code === 'BATCH_TARGET_CONFLICT');
  const unresolved = await plan(f, input); assert.equal(unresolved.ready, false);
  await assert.rejects(f.catalog.fileOperations.execute(f.project.id, confirmation(unresolved)), e => e.code === 'PREVIEW_REQUIRED');
  const done = await finish(f, await plan(f, {...input, choices: {[b.id]: 'rename'}}));
  assert.equal(done.status, 'ready', done.error); assert.equal(path.basename(source(f, b).path), 'case_0.mp4');
  for (const s of [a, b]) {assert.equal(source(f, s).identity.ino, s.identity.ino); assert.equal(f.catalog.metadata(f.project.id, source(f, s)).data.removedAt, 0);}
});

const guards = state => ({documentId: state.documentId, initializedAt: state.initializedAt, expectedStoryboardRevision: state.storyboardRevision, expectedPlanRevision: state.plan.revision, timingHash: state.timingHash});

test('independent: source/overwrite union deduplicates a whole mixed take created through normal APIs', async t => {
  const f = await fixture(t); initialize(f);
  const area = await folder(f, '收纳处'); await setRole(f, area.id);
  const target = await imported(f, 'mixed.mp4', area.id), a = await imported(f, 'mixed.mp4'), outside = await imported(f, 'outside.mp4');
  await bind(f, a, [0]);
  let state = base(f); const shotId = state.shots[0].id, oldTake = state.plan.adopted[shotId];
  await f.entry.store.calibrate(f.project.id, oldTake, {guards: guards(state), adopt: true, segments: [
    {sourceId: a.id, inMs: 0, outMs: 300}, {sourceId: target.id, inMs: 0, outMs: 300}, {sourceId: outside.id, inMs: 0, outMs: 400},
  ]});
  state = base(f); const beforeTakes = state.takes, beforeShots = state.shots, outsideBefore = source(f, outside);
  const p = await plan(f, {kind: 'move-videos', sourceIds: [a.id], destinationFolderId: area.id, unbindAdoptions: true, choices: {[a.id]: 'overwrite'}});
  assert.deepEqual(p.affectedShots.map(s => s.id), [shotId]); assert.equal(p.sourceUnbindShots.length, 1); assert.equal(p.overwriteTargetUnbindShots.length, 1);
  assert.deepEqual(new Set(p.affectedShots[0].sourceIds), new Set([a.id, target.id]));
  for (const ids of [[], [shotId, shotId], [shotId, randomUUID()], [randomUUID()]]) {
    await assert.rejects(f.catalog.fileOperations.execute(f.project.id, {...confirmation(p), confirmedUnbindShotIds: ids}), e => e.code === 'UNBIND_CONFIRMATION_REQUIRED');
  }
  assert.deepEqual(base(f).plan, state.plan); assert.equal(await present(a.path), true);
  const done = await finish(f, p); assert.equal(done.status, 'ready', done.error); assert.deepEqual(done.unboundShotIds, [shotId]);
  assert.deepEqual(base(f).plan.adopted, {}); assert.deepEqual(base(f).takes, beforeTakes); assert.deepEqual(base(f).shots, beforeShots);
  assert.deepEqual(source(f, outside), outsideBefore); assert.equal(f.catalog.metadata(f.project.id, source(f, a)).data.removedAt, 0);
  assert.ok(f.catalog.metadata(f.project.id, source(f, target)).data.removedAt > 0);
  assert.equal(f.catalog.isManaged(f.project.id, source(f, a)), true);
});

test('independent: a replaced later source cannot inherit its frozen ID after preview', async t => {
  const f = await fixture(t); initialize(f);
  const area = await folder(f, '收纳处'); await setRole(f, area.id);
  const a = await imported(f, 'a.mp4'), b = await imported(f, 'b.mp4'); await bind(f, a, [0]);
  const before = base(f).plan, p = await plan(f, {kind: 'move-videos', sourceIds: [a.id, b.id], destinationFolderId: area.id, unbindAdoptions: true});
  await fs.rename(b.path, path.join(f.dir, 'owned-original-b.mp4')); await fs.writeFile(b.path, 'independent replacement');
  const done = await finish(f, p); assert.equal(done.status, 'failed');
  assert.equal(await present(a.path), true); assert.equal(await present(path.join(area.path, a.name)), false);
  assert.deepEqual(source(f, b).identity, b.identity); assert.equal(await fs.readFile(b.path, 'utf8'), 'independent replacement');
  assert.deepEqual(base(f).plan, before); assert.equal(f.catalog.fileOperations.row(f.project.id, p.requestId).steps.length, 0);
});

test('independent: roles CAS after byte movement rolls back the batch without reverting the newer setting', async t => {
  const f = await fixture(t); initialize(f);
  const area = await folder(f, '收纳处'); await setRole(f, area.id);
  const a = await imported(f, 'roles-cas.mp4'); await bind(f, a, [0]);
  const before = base(f).plan, revision = f.catalog.folders.roleState(f.project.id).revision;
  const p = await plan(f, {kind: 'move-videos', sourceIds: [a.id], destinationFolderId: area.id, unbindAdoptions: true});
  const step = f.catalog.fileOperations.step.bind(f.catalog.fileOperations);
  const mock = t.mock.method(f.catalog.fileOperations, 'step', async (...args) => {await step(...args); f.entry.store.tx(() => f.catalog.folders.completeUpgrade(f.project.id));});
  const done = await finish(f, p); mock.mock.restore();
  assert.equal(done.status, 'failed', done.error); assert.deepEqual(base(f).plan, before);
  assert.equal(await present(a.path), true); assert.equal(source(f, a).path, a.path);
  assert.equal(f.catalog.folders.roleState(f.project.id).revision, revision + 1); assert.equal(f.catalog.folders.settings(f.project.id).upgradeCompleted, true);
});

test('independent: adoption CAS after byte movement preserves the newer plan and rolls bytes back', async t => {
  const f = await fixture(t); initialize(f);
  const area = await folder(f, '收纳处'); await setRole(f, area.id);
  const a = await imported(f, 'adoption-cas.mp4'), other = await imported(f, 'untouched.mp4'); await bind(f, a, [0]); await bind(f, other, [1]);
  const p = await plan(f, {kind: 'move-videos', sourceIds: [a.id], destinationFolderId: area.id, unbindAdoptions: true});
  const step = f.catalog.fileOperations.step.bind(f.catalog.fileOperations); let newer;
  const mock = t.mock.method(f.catalog.fileOperations, 'step', async (...args) => {
    await step(...args); const state = base(f), adopted = {...state.plan.adopted}; delete adopted[state.shots[1].id];
    await f.entry.store.adopt(f.project.id, {guards: guards(state), adopted}); newer = base(f).plan;
  });
  const done = await finish(f, p); mock.mock.restore();
  assert.equal(done.status, 'failed', done.error); assert.deepEqual(base(f).plan, newer);
  assert.equal(await present(a.path), true); assert.equal(source(f, a).path, a.path); assert.equal(f.catalog.isManaged(f.project.id, source(f, a)), true);
});

test('independent: uncertain IO preserves foreign target bytes, stops remaining items, and never replays', async t => {
  const f = await fixture(t); initialize(f);
  const area = await folder(f, '收纳处'); await setRole(f, area.id);
  const a = await imported(f, 'uncertain.mp4'), b = await imported(f, 'unstarted.mp4'); await bind(f, a, [0]);
  const before = base(f).plan, p = await plan(f, {kind: 'move-videos', sourceIds: [a.id, b.id], destinationFolderId: area.id, unbindAdoptions: true});
  const link = fs.link.bind(fs); let calls = 0;
  const mock = t.mock.method(fs, 'link', async (from, to) => {
    calls++; await link(from, to); await fs.unlink(to); await fs.writeFile(to, 'independent foreign bytes');
    throw Object.assign(Error('independent: link outcome unsettled after external replacement'), {code: 'EIO'});
  });
  const done = await finish(f, p); mock.mock.restore();
  assert.equal(done.status, 'unknown'); assert.deepEqual(done.items.map(s => s.status), ['unknown', 'not-run']);
  assert.deepEqual(base(f).plan, before); assert.equal(await present(b.path), true); assert.equal(calls, 1);
  assert.equal(await fs.readFile(path.join(area.path, a.name), 'utf8'), 'independent foreign bytes');
  assert.equal((await finish(f, p)).status, 'unknown'); assert.equal(calls, 1);
  await assert.rejects(plan(f, {kind: 'move-video', sourceId: b.id, destinationFolderId: area.id, unbindAdoptions: true}), e => e.code === 'OPERATION_UNSETTLED');
});

test('independent: ancestor deletion clears role only with committed folder metadata', async t => {
  const f = await fixture(t); initialize(f);
  const shell = await folder(f, '祖先'), area = await folder(f, '收纳处', shell.id); await setRole(f, area.id);
  const a = await imported(f, 'ancestor.mp4', area.id); await bind(f, a, [0]);
  const roles = f.catalog.folders.roleState(f.project.id), before = base(f).plan;
  const p = await plan(f, {kind: 'delete-folder', folderId: shell.id, mode: 'contents-to-root'});
  const write = f.catalog.folders.write.bind(f.catalog.folders); let rejected = false;
  const mock = t.mock.method(f.catalog.folders, 'write', (id, folderId, data) => {
    if (!rejected && folderId === shell.id && data.removedAt) {rejected = true; throw Error('independent: metadata fail after transactional role clearing');}
    return write(id, folderId, data);
  });
  const failed = await finish(f, p); mock.mock.restore();
  assert.equal(failed.status, 'failed', failed.error); assert.equal(await present(a.path), true);
  assert.deepEqual(f.catalog.folders.roleState(f.project.id), roles); assert.deepEqual(base(f).plan, before);
  const done = await finish(f, await plan(f, {kind: 'delete-folder', folderId: shell.id, mode: 'contents-to-root'}));
  assert.equal(done.status, 'ready', done.error); assert.equal(f.catalog.folders.roleState(f.project.id).rejectFolderId, null);
  assert.equal(f.catalog.folders.row(f.project.id, area.id).parentId, 'root'); assert.equal(await present(source(f, a).path), true);
  assert.deepEqual(base(f).plan, before);
});

test('independent: concurrent role previews use CAS and preserve the first committed role', async t => {
  const f = await fixture(t), a = await folder(f, '甲'), b = await folder(f, '乙');
  const left = await rolePlan(f, {folderId: a.id}), right = await rolePlan(f, {folderId: b.id});
  await Promise.all([f.catalog.rejectArea.execute(f.project.id, {...confirmation(left), confirmRoleChange: true}), f.catalog.rejectArea.execute(f.project.id, {...confirmation(right), confirmRoleChange: true})]);
  await f.catalog.queue;
  const results = [left, right].map(p => f.catalog.rejectArea.row(f.project.id, p.requestId));
  assert.deepEqual(results.map(s => s.status), ['ready', 'failed']); assert.equal(results[1].errorCode, 'FOLDER_ROLES_CONFLICT');
  assert.equal(f.catalog.folders.roleState(f.project.id).revision, 1); assert.equal(f.catalog.folders.roleState(f.project.id).rejectFolderId, a.id);
  assert.equal(await present(a.path), true); assert.equal(await present(b.path), true);
});

test('independent: legacy move journals work without a role but cannot bypass a newly assigned reject role', async t => {
  const f = await fixture(t), destination = await folder(f, '普通目录'), a = await imported(f, 'legacy.mp4');
  const withoutRoleSnapshot = p => {
    const s = f.catalog.fileOperations.row(f.project.id, p.requestId); delete s.roles;
    f.catalog.fileOperations.save(f.project.id, p.requestId, s);
  };
  let p = await plan(f, {kind: 'move-video', sourceId: a.id, destinationFolderId: destination.id}); withoutRoleSnapshot(p);
  assert.equal((await finish(f, p)).status, 'ready');
  const atDestination = source(f, a);
  p = await plan(f, {kind: 'move-video', sourceId: a.id, destinationFolderId: 'root'}); withoutRoleSnapshot(p);
  await setRole(f, destination.id);
  const done = await finish(f, p); assert.equal(done.status, 'failed'); assert.match(done.error, /废片收纳处/);
  assert.equal(source(f, a).path, atDestination.path); assert.equal(await present(atDestination.path), true);
  assert.equal(await present(a.path), false);
});

test('independent: role backup restore preserves revision and rejects cross-project or removed pointers', async t => {
  const f = await fixture(t), area = await folder(f, '收纳处'); await setRole(f, area.id);
  f.entry.store.tx(() => f.catalog.folders.completeUpgrade(f.project.id));
  const backup = f.storyboards.backup(); f.storyboards.validateBackup(backup);
  const setting = backup.video_preview.project_video_settings.find(r => r.id === f.project.id);
  const restored = await fixture(t);
  restored.projects.save(restored.project.id, {name: '独验恢复空项目-' + randomUUID()});
  restored.projects.save(restored.other.id, {name: '独验恢复其他空项目-' + randomUUID()});
  await restored.storyboards.restore(backup);
  assert.deepEqual(restored.lib.db.prepare('SELECT * FROM project_video_settings WHERE id=?').get(f.project.id), setting);
  assert.deepEqual(restored.catalog.folders.settings(f.project.id), {upgradeCompleted: true, rejectFolderId: area.id});
  for (const mutate of [
    copy => {copy.video_preview.project_video_folders.find(r => r.id === area.id).project_id = f.other.id;},
    copy => {const row = copy.video_preview.project_video_folders.find(r => r.id === area.id); row.data_json = JSON.stringify({...JSON.parse(row.data_json), removedAt: Date.now()});},
    copy => {const row = copy.video_preview.project_video_settings.find(r => r.id === f.project.id); row.data_json = JSON.stringify({upgradeCompleted: true, rejectFolderId: randomUUID()});},
  ]) {
    const copy = structuredClone(backup); mutate(copy);
    // Exercise the role validator itself; the outer backup checksum must not
    // mask invalid role pointers before their business validation is reached.
    assert.throws(() => f.entry.store.validateBackup(copy.video_preview, copy.tables.storyboard_documents, copy.creative.projects), e => e.code === 'VIDEO_BACKUP_INVALID');
  }
});

test('independent: complete shutdown waits for tracked role work and leaves no resources or implicit creation', async t => {
  const f = await fixture(t), p = await rolePlan(f, {create: {parentId: 'root', name: 'closing-role'}});
  let enter, release; const entered = new Promise(resolve => {enter = resolve;}), gate = new Promise(resolve => {release = resolve;});
  const check = f.catalog.rejectArea.checkLocation.bind(f.catalog.rejectArea);
  const mock = t.mock.method(f.catalog.rejectArea, 'checkLocation', async (...args) => {enter(); await gate; return check(...args);});
  await f.catalog.rejectArea.execute(f.project.id, {...confirmation(p), confirmRoleChange: true}); await entered;
  let closed = false; const closing = Promise.all([f.catalog.close(), f.entry.close()]).then(() => {closed = true;});
  try {await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false, 'Whole application video shutdown must await tracked role work');}
  finally {release(); await closing; mock.mock.restore();}
  assert.equal(f.catalog.rejectArea.active.size, 0); assert.equal(f.entry.media.work.size, 0);
  assert.equal(f.entry.media.handles.size, 0); assert.equal(f.entry.media.children.size, 0); assert.equal(f.entry.media.closes.size, 0);
  assert.equal(f.catalog.rejectArea.row(f.project.id, p.requestId).status, 'failed');
  assert.equal(f.catalog.folders.roleState(f.project.id).rejectFolderId, null);
  assert.equal(await present(path.join(await f.catalog.folders.rootPath(f.project.id), 'closing-role')), false);
});

for (const commitSucceeded of [true, false]) {
  test(`independent delta: unreadable durable result after ${commitSucceeded ? 'COMMIT' : 'transaction rollback'} never triggers speculative filesystem rollback`, async t => {
    const f = await fixture(t); initialize(f);
    const area = await folder(f, '读回失败收纳处'); await setRole(f, area.id);
    const a = await imported(f, 'readback.mp4'); await bind(f, a, [0]);
    const before = base(f).plan;
    const p = await plan(f, {kind: 'move-videos', sourceIds: [a.id], destinationFolderId: area.id, unbindAdoptions: true});
    const operations = f.catalog.fileOperations;
    const tx = f.entry.store.tx.bind(f.entry.store), row = operations.row.bind(operations), save = operations.save.bind(operations);
    const perform = operations.perform.bind(operations), rollback = operations.rollback.bind(operations);
    let failRead = false, deniedReads = 0, rollbackCalls = 0, performResult;
    const savedStatuses = [];
    t.mock.method(operations, 'save', (id, requestId, data) => {
      if (requestId === p.requestId) {
        savedStatuses.push(data.status);
        if (!commitSucceeded && data.status === 'ready') throw Error('independent delta: READY write rejected inside transaction');
      }
      return save(id, requestId, data);
    });
    t.mock.method(f.entry.store, 'tx', fn => {
      try {
        const result = tx(fn);
        if (commitSucceeded) {failRead = true; throw Error('independent delta: committed ACK lost');}
        return result;
      } catch (e) {failRead = true; throw e;}
    });
    t.mock.method(operations, 'row', (id, requestId) => {
      if (failRead && deniedReads === 0 && requestId === p.requestId) {deniedReads++; throw Error('independent delta: durable read temporarily unavailable');}
      return row(id, requestId);
    });
    t.mock.method(operations, 'rollback', (...args) => {rollbackCalls++; return rollback(...args);});
    t.mock.method(operations, 'perform', async (...args) => {performResult = await perform(...args); return performResult;});
    const done = await finish(f, p);
    t.mock.restoreAll();
    const durable = row(f.project.id, p.requestId), destination = path.join(area.path, a.name);
    t.diagnostic(JSON.stringify({commitSucceeded, returned: performResult?.status, durable: durable.status, query: done.status, deniedReads, rollbackCalls, wroteUnknown: savedStatuses.includes('unknown'), originalExists: await present(a.path), destinationExists: await present(destination)}));
    assert.equal(deniedReads, 1); assert.equal(performResult.status, 'unknown'); assert.equal(rollbackCalls, 0);
    assert.equal(savedStatuses.includes('unknown'), false, 'An unavailable read must not overwrite a potentially committed READY');
    assert.equal(savedStatuses.includes('failed'), false); assert.equal(await present(a.path), false);
    assert.deepEqual(await fs.readFile(destination), f.bytes);
    if (commitSucceeded) {
      assert.equal(durable.status, 'ready'); assert.equal(done.status, 'ready'); assert.equal(source(f, a).path, destination);
      assert.deepEqual(base(f).plan.adopted, {});
      assert.equal((await operations.recover(f.project.id, p.requestId, {action: 'rollback'})).status, 'ready');
      assert.equal(await present(destination), true); assert.equal(await present(a.path), false);
    } else {
      assert.equal(durable.status, 'running'); assert.equal(done.status, 'unknown'); assert.equal(source(f, a).path, a.path);
      assert.deepEqual(base(f).plan, before);
      assert.equal((await operations.recover(f.project.id, p.requestId, {action: 'rollback'})).status, 'failed');
      assert.equal(await present(destination), false); assert.deepEqual(await fs.readFile(a.path), f.bytes);
      assert.deepEqual(base(f).plan, before);
    }
  });
}

test('independent delta: every source revision is checked before undoing any bytes from an old UNKNOWN journal', async t => {
  const f = await fixture(t), area = await folder(f, '旧回执收纳处'); await setRole(f, area.id);
  const a = await imported(f, 'earlier.mp4'), b = await imported(f, 'later.mp4');
  const p = await plan(f, {kind: 'move-videos', sourceIds: [a.id, b.id], destinationFolderId: area.id, unbindAdoptions: true});
  // Recreate a crash journal after all IO, before the metadata transaction. The
  // old reverse loop would undo b first and only discover a's later edit at end.
  const operations = f.catalog.fileOperations, s = operations.row(f.project.id, p.requestId);
  s.status = 'running'; operations.save(f.project.id, p.requestId, s);
  for (const move of s.moves) {
    s.currentItemId = move.sourceId;
    await operations.step(f.project.id, p.requestId, s, move.source, move.target, move.kind);
  }
  delete s.currentItemId; s.status = 'unknown'; operations.save(f.project.id, p.requestId, s);
  const meta = f.catalog.metadata(f.project.id, a);
  f.entry.store.tx(() => f.catalog.record(f.project.id, a.id, {...meta.data, notes: 'independent delta: newer source edit'}, meta.row.revision + 1));
  const rename = fs.rename.bind(fs); let undoCalls = 0;
  const mock = t.mock.method(fs, 'rename', (...args) => {undoCalls++; return rename(...args);});
  await assert.rejects(operations.recover(f.project.id, p.requestId, {action: 'rollback'}), e => e.code === 'RECOVERY_CONFLICT');
  mock.mock.restore();
  assert.equal(undoCalls, 0, 'All source metadata must be checked before even the last item is moved back');
  for (const item of [a, b]) {
    assert.equal(await present(item.path), false); assert.deepEqual(await fs.readFile(path.join(area.path, item.name)), f.bytes);
    assert.equal(source(f, item).path, item.path);
  }
  assert.equal(f.catalog.metadata(f.project.id, a).data.notes, 'independent delta: newer source edit');
  assert.equal(operations.row(f.project.id, p.requestId).status, 'unknown');
});

test('independent delta: committed folder metadata blocks recovery of an old erroneous UNKNOWN journal before filesystem changes', async t => {
  const f = await fixture(t), parent = await folder(f, '原目录'), child = await folder(f, '子目录', parent.id), destination = await folder(f, '目标');
  const p = await plan(f, {kind: 'move-folder', folderId: parent.id, destinationFolderId: destination.id});
  assert.equal((await finish(f, p)).status, 'ready');
  const operations = f.catalog.fileOperations, s = operations.row(f.project.id, p.requestId);
  assert.deepEqual(s.sourceRows, []); // No source guard can mask the folder guard.
  s.status = 'unknown'; operations.save(f.project.id, p.requestId, s);
  const before = f.catalog.folders.rows(f.project.id), currentParent = path.join(destination.path, parent.name), currentChild = path.join(currentParent, child.name);
  const rename = fs.rename.bind(fs), mkdir = fs.mkdir.bind(fs); let filesystemChanges = 0;
  t.mock.method(fs, 'rename', (...args) => {filesystemChanges++; return rename(...args);});
  t.mock.method(fs, 'mkdir', (...args) => {filesystemChanges++; return mkdir(...args);});
  await assert.rejects(operations.recover(f.project.id, p.requestId, {action: 'rollback'}), e => e.code === 'RECOVERY_CONFLICT');
  t.mock.restoreAll();
  assert.equal(filesystemChanges, 0); assert.equal(await present(parent.path), false);
  assert.equal(await present(currentParent), true); assert.equal(await present(currentChild), true);
  assert.deepEqual(f.catalog.folders.rows(f.project.id), before);
});

async function independentReceiptHttp(t, f) {
  const {default: express} = await import('express');
  const {createServer} = await import('node:http');
  const {projectVideoRouter} = await import('../server/project-videos/router.mjs');
  const app = express(); app.use('/api/project-videos', projectVideoRouter(f.catalog));
  const server = createServer(app);
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  const url = `http://127.0.0.1:${server.address().port}/api/project-videos/projects/${f.project.id}`;
  return {
    post: (route, body) => fetch(url + route, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)}),
    get: route => fetch(url + route),
  };
}

test('independent receipt: GET after role create preview reports not started, performs no mkdir, and permits explicit same-request execution', async t => {
  const f = await fixture(t), http = await independentReceiptHttp(t, f);
  const requestId = randomUUID(), root = await f.catalog.folders.rootPath(f.project.id);
  const beforeRoles = f.catalog.folders.roleState(f.project.id), beforeFolders = f.catalog.folders.rows(f.project.id);
  const settings = () => f.lib.db.prepare('SELECT * FROM project_video_settings ORDER BY id').all();
  const beforeSettings = settings(), mkdir = fs.mkdir.bind(fs), execute = f.catalog.rejectArea.execute.bind(f.catalog.rejectArea);
  let mkdirCalls = 0, executionCalls = 0;
  t.mock.method(fs, 'mkdir', (...args) => {mkdirCalls++; return mkdir(...args);});
  t.mock.method(f.catalog.rejectArea, 'execute', (...args) => {executionCalls++; return execute(...args);});
  const response = await http.post('/folders/reject/preview', {requestId, expectedRolesRevision: beforeRoles.revision, create: {parentId: 'root', name: '仅预览收纳处'}});
  assert.equal(response.status, 200); const p = await response.json(); assert.equal(p.ready, true);
  for (let n = 0; n < 2; n++) {
    const queried = await http.get('/operations/' + requestId); assert.equal(queried.status, 200);
    const receipt = await queried.json();
    assert.equal(receipt.requestId, requestId); assert.equal(receipt.status, 'unknown');
    assert.equal(receipt.phase, 'preview'); assert.equal(receipt.errorCode, 'OPERATION_NOT_STARTED');
    assert.equal(receipt.canRecover, false); assert.deepEqual(receipt.unboundShotIds, []);
    assert.match(receipt.error, /预览/);
  }
  assert.equal(mkdirCalls, 0); assert.equal(executionCalls, 0); assert.equal(await present(root), false);
  assert.deepEqual(f.catalog.folders.roleState(f.project.id), beforeRoles); assert.deepEqual(f.catalog.folders.rows(f.project.id), beforeFolders);
  assert.deepEqual(settings(), beforeSettings); assert.equal(f.catalog.rejectArea.active.size, 0);
  assert.equal(f.catalog.rejectArea.row(f.project.id, requestId).status, 'preview');
  // Only this explicit POST may start the operation; GET has preserved the preview.
  const started = await http.post('/folders/reject', {...confirmation(p), confirmRoleChange: true}); assert.equal(started.status, 200);
  await f.catalog.rejectArea.active.get(requestId);
  const done = await (await http.get('/operations/' + requestId)).json();
  assert.equal(done.status, 'ready', done.error); assert.equal(done.requestId, requestId); assert.equal(executionCalls, 1);
  assert.ok(mkdirCalls > 0); assert.equal(done.folderId, p.roleChange.afterFolderId);
  assert.equal(f.catalog.folders.roleState(f.project.id).rejectFolderId, p.roleChange.afterFolderId);
  assert.equal(await present(path.join(root, '仅预览收纳处')), true);
  t.mock.restoreAll();
});

test('independent receipt: GET after batch preview reports not started with not-run items and no moves or unbinds until explicit execution', async t => {
  const f = await fixture(t); initialize(f);
  const area = await folder(f, '仅预览批量收纳处'); await setRole(f, area.id);
  const a = await imported(f, 'preview-a.mp4'), b = await imported(f, 'preview-b.mp4'); await bind(f, a, [0]); await bind(f, b, [1]);
  const http = await independentReceiptHttp(t, f), requestId = randomUUID(), before = base(f);
  const operations = f.catalog.fileOperations, execute = operations.execute.bind(operations), detach = f.catalog.detachSources.bind(f.catalog);
  let executionCalls = 0, detachCalls = 0, fileChanges = 0;
  for (const name of ['link', 'unlink', 'rename']) {
    const original = fs[name].bind(fs); t.mock.method(fs, name, (...args) => {fileChanges++; return original(...args);});
  }
  t.mock.method(operations, 'execute', (...args) => {executionCalls++; return execute(...args);});
  t.mock.method(f.catalog, 'detachSources', (...args) => {detachCalls++; return detach(...args);});
  const response = await http.post('/operations/preview', {requestId, kind: 'move-videos', sourceIds: [a.id, b.id], destinationFolderId: area.id, unbindAdoptions: true, expectedRolesRevision: f.catalog.folders.roleState(f.project.id).revision});
  assert.equal(response.status, 200); const p = await response.json(); assert.equal(p.ready, true); assert.equal(p.affectedShots.length, 2);
  for (let n = 0; n < 2; n++) {
    const queried = await http.get('/operations/' + requestId); assert.equal(queried.status, 200);
    const receipt = await queried.json();
    assert.equal(receipt.requestId, requestId); assert.equal(receipt.status, 'unknown');
    assert.equal(receipt.phase, 'preview'); assert.equal(receipt.errorCode, 'OPERATION_NOT_STARTED'); assert.equal(receipt.canRecover, false);
    assert.deepEqual(receipt.items.map(item => item.sourceId), [a.id, b.id]); assert.deepEqual(receipt.items.map(item => item.status), ['not-run', 'not-run']);
    assert.deepEqual(receipt.unboundShotIds, []); for (const item of receipt.items) assert.deepEqual(item.unboundShotIds, []);
  }
  assert.equal(executionCalls, 0); assert.equal(detachCalls, 0); assert.equal(fileChanges, 0);
  assert.deepEqual(base(f).plan, before.plan); assert.deepEqual(base(f).takes, before.takes);
  for (const item of [a, b]) {
    assert.deepEqual(source(f, item), item); assert.deepEqual(await fs.readFile(item.path), f.bytes);
    assert.equal(await present(path.join(area.path, item.name)), false);
  }
  assert.equal(operations.row(f.project.id, requestId).status, 'preview'); assert.deepEqual(operations.row(f.project.id, requestId).steps, []);
  // No polling helper resubmits: the one explicit execution keeps the original ID.
  const started = await http.post('/operations', confirmation(p)); assert.equal(started.status, 200); await f.catalog.queue;
  const done = await (await http.get('/operations/' + requestId)).json();
  assert.equal(done.status, 'ready', done.error); assert.equal(done.requestId, requestId); assert.equal(executionCalls, 1); assert.equal(detachCalls, 1);
  assert.ok(fileChanges > 0); assert.deepEqual(done.items.map(item => item.status), ['ready', 'ready']); assert.deepEqual(base(f).plan.adopted, {});
  assert.deepEqual(base(f).takes, before.takes); assert.deepEqual(base(f).shots, before.shots);
  for (const item of [a, b]) {
    assert.equal(source(f, item).path, path.join(area.path, item.name)); assert.equal(await present(item.path), false);
    assert.equal(f.catalog.metadata(f.project.id, source(f, item)).data.removedAt, 0);
  }
  t.mock.restoreAll();
});
