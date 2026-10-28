import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteFixture, rows, fixedId } from './cloud-upload-batch-mysql-fixture.mjs';
import { uuid } from '../server/cloud-upload-protocol.mjs';
const stored = (f, id) => f.store.get('cloud_upload_batch_items', { itemId: id });
const attempt = (f, r) => f.store.get('cloud_upload_item_attempts', { attemptId: r.currentAttemptId });
const resume = (f, b) => f.batches.command(f.who, b.batchId, { clientCommandId: uuid(), expectedVersion: f.store.get('cloud_upload_batches', { batchId: b.batchId }).version, action: 'resume' });
test('crash around intent creation preserves DB IDs and replays exactly one intent', async (t) => {
    for (const point of ['after-attempt-db', 'after-intent-durable']) {
        const f = await sqliteFixture(t, rows(1)), { b, items } = await f.create();
        f.crash = point;
        await assert.rejects(f.batches.prepareItem(f.who, items[0].itemId), { code: 'CRASH_TEST' });
        const before = stored(f, items[0].itemId);
        assert.ok(before.currentAttemptId);
        assert.equal(f.upload.jobs.size, point === 'after-attempt-db' ? 0 : 1);
        f.crash = null;
        f.reopen();
        f.batches.recover(f.who);
        resume(f, b);
        await f.batches.prepareItem(f.who, before.itemId);
        const after = stored(f, before.itemId);
        for (const k of ['currentAttemptId', 'intentId', 'clientRequestId'])
            assert.equal(after[k], before[k]);
        assert.equal(f.upload.jobs.size, 1);
    }
});
test('receipt commit before forget survives each adjacent crash and cleanup is replayable', async (t) => {
    for (const point of ['after-receipt-db', 'after-forget']) {
        const f = await sqliteFixture(t, rows(1)), { b, items } = await f.create();
        await f.batches.prepareItem(f.who, items[0].itemId);
        const r = stored(f, items[0].itemId), a = attempt(f, r), receipt = f.receipt(r, a);
        f.crash = point;
        await assert.rejects(f.batches.recordReceipt(f.who, r.itemId, a.attemptId, receipt), { code: 'CRASH_TEST' });
        assert.equal(stored(f, r.itemId).receipt.receiptId, receipt.receiptId);
        assert.equal(stored(f, r.itemId).cleanupPending, true);
        assert.equal(f.batches.summary(f.who, b.batchId).state, 'COMPLETED');
        assert.equal(f.upload.jobs.size, point === 'after-receipt-db' ? 1 : 0);
        f.crash = null;
        f.reopen();
        await f.batches.recordReceipt(f.who, r.itemId, a.attemptId, receipt);
        assert.equal(stored(f, r.itemId).cleanupPending, false);
        assert.equal(f.upload.jobs.size, 0);
        assert.equal(f.batches.summary(f.who, b.batchId).counts.uploaded, 1);
        await assert.rejects(f.batches.recordReceipt(f.who, r.itemId, a.attemptId, { ...receipt, receiptId: uuid() }), { code: 'RECEIPT_CONFLICT' });
    }
});
test('unknown keeps original IDs; stop remains STOPPING until late authoritative success', async (t) => {
    const f = await sqliteFixture(t, rows(2)), { b, items } = await f.create();
    await f.batches.prepareItem(f.who, items[0].itemId);
    const r = stored(f, items[0].itemId), a = attempt(f, r);
    f.upload.jobs.get(r.intentId).state = 'unknown';
    await f.batches.prepareItem(f.who, r.itemId);
    assert.equal(stored(f, r.itemId).state, 'RECONCILING');
    assert.equal(stored(f, r.itemId).currentAttemptId, a.attemptId);
    const result = f.batches.command(f.who, b.batchId, { clientCommandId: uuid(), expectedVersion: b.version, action: 'stop' });
    assert.equal(result.state, 'STOPPING');
    assert.equal(f.upload.jobs.size, 1);
    await f.batches.recordReceipt(f.who, r.itemId, a.attemptId, f.receipt(r, a));
    assert.equal(f.batches.summary(f.who, b.batchId).state, 'STOPPED');
    assert.equal(stored(f, items[1].itemId).state, 'CANCELLED');
    assert.equal(f.upload.jobs.size, 0);
});
test('late old-identity receipt persists only original scope and never cleans current identity', async (t) => {
    for (const dimension of ['accountId', 'cloudServiceKey', 'deviceId', 'librarySourceId', 'epoch']) {
        const f = await sqliteFixture(t, rows(1)), { b, items } = await f.create();
        await f.batches.prepareItem(f.who, items[0].itemId);
        const old = f.who, r = stored(f, items[0].itemId), a = attempt(f, r);
        f.who = { ...old, [dimension]: dimension === 'epoch' ? 2 : dimension === 'cloudServiceKey' ? 'c'.repeat(64) : uuid() };
        assert.throws(() => f.batches.beginAttempt(old, r.itemId), { code: 'AUTH_CHANGED' });
        const result = await f.batches.recordReceipt(old, r.itemId, a.attemptId, f.receipt(r, a));
        assert.equal(result.cleanupPending, true);
        assert.equal(f.upload.jobs.size, 1);
        assert.equal(stored(f, r.itemId).receipt.clientRequestId, a.clientRequestId);
        assert.equal(f.upload.events.filter(e => e[0] === 'forget').length, 0);
        if (dimension !== 'epoch')
            assert.throws(() => f.batches.summary(f.who, b.batchId), { code: 'NOT_FOUND' });
    }
});
test('only fenced terminal attempt allows an explicit retry with new IDs', async (t) => {
    const f = await sqliteFixture(t, rows(1)), { b, items } = await f.create();
    await f.batches.prepareItem(f.who, items[0].itemId);
    const r = stored(f, items[0].itemId), a = attempt(f, r);
    assert.throws(() => f.batches.terminalAttempt(f.who, r.itemId, a.attemptId, { commitState: 'UNKNOWN', workerSettled: true, operationsSettled: true }), { code: 'NEEDS_RECONCILIATION' });
    f.batches.terminalAttempt(f.who, r.itemId, a.attemptId, { commitState: 'NOT_COMMITTED', workerSettled: true, operationsSettled: true });
    assert.equal(f.batches.summary(f.who, b.batchId).state, 'COMPLETED_WITH_ISSUES');
    assert.throws(() => f.batches.beginAttempt(f.who, r.itemId), {code:'ITEM_TERMINAL'});
    const current = f.store.get('cloud_upload_batches', { batchId: b.batchId });
    f.batches.command(f.who, b.batchId, { clientCommandId: uuid(), expectedVersion: current.version, action: 'retry-failed' });
    const next = f.batches.beginAttempt(f.who, r.itemId);
    assert.notEqual(next.attempt.attemptId, a.attemptId);
    assert.notEqual(next.attempt.clientRequestId, a.clientRequestId);
    assert.equal(attempt(f, r).state, 'FAILED_FENCED');
});
test('60 sequential items complete using a bounded intent window and distinct receipt modes', async (t) => {
    const f = await sqliteFixture(t, rows(60)), { b, items } = await f.create();
    for (const [i, item] of items.entries()) {
        await f.batches.prepareItem(f.who, item.itemId);
        const r = stored(f, item.itemId), a = attempt(f, r);
        await f.batches.recordReceipt(f.who, r.itemId, a.attemptId, f.receipt(r, a, ['uploaded', 'reused', 'already_present'][i % 3]));
    }
    assert.equal(f.upload.maximum, 1);
    assert.equal(f.upload.jobs.size, 0);
    const s = f.batches.summary(f.who, b.batchId);
    assert.equal(s.state, 'COMPLETED');
    assert.deepEqual(s.counts, { uploaded: 20, reused: 20, already_present: 20, legacy_unrecorded: 0, committed: 60, pending: 0 });
    f.reopen();
    assert.deepEqual(f.batches.summary(f.who, b.batchId), s);
});
test('source proof change refuses existing attempt replay rather than starting new request', async (t) => {
    const f = await sqliteFixture(t, rows(1)), { p, items } = await f.create();
    await f.batches.prepareItem(f.who, items[0].itemId);
    const r = stored(f, items[0].itemId);
    f.preview.revise(f.who, p.previewId, p.version, r.assetId, { fileName: 'new.wav' });
    await assert.rejects(f.batches.prepareItem(f.who, r.itemId), { code: 'REPRESENTATIVE_STALE' });
    assert.equal(stored(f, r.itemId).currentAttemptId, r.currentAttemptId);
    assert.equal(f.upload.jobs.size, 1);
});
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { CloudAudioUpload } from '../server/cloud-audio-upload.mjs';
async function actualUploadFixture(t) {
    const f = await sqliteFixture(t, []), media = path.join(f.dir, 'media');
    await fs.mkdir(media);
    const file = path.join(media, 'synthetic.wav');
    await fs.writeFile(file, Buffer.alloc(4096, 17));
    const assetId = uuid(), rootId = f.input().scopes[0].rootId, a = { id: assetId, root_id: rootId, kind: 'music', category: 'A', sub: 'B', trashed: 0 }, root = { id: rootId, path: await fs.realpath(media), retired: 0 };
    const lib = { dataDir: f.dir, asset: () => a, rootById: () => root, source: async () => ({ a, p: file, stat: await fs.stat(file) }) };
    const auth = { epoch: 1, getState: () => ({ configured: true, state: 'logged-in', originHost: 'fixture.invalid', accountId: f.who.accountId, deviceId: f.who.deviceId }) };
    let uploader = await new CloudAudioUpload(lib, { cloudAuth: auth, enabled: true }).init();
    t.after(() => uploader.dispose());
    const inspected = await uploader.inspectForBatch(assetId);
    f.sourceRows = [{ ...inspected, target: { visibility: 'PRIVATE', groupId: null } }];
    f.batches.upload = uploader;
    return { f, file, lib, auth, inspected, get uploader() { return uploader; }, async restart() { await uploader.dispose(); uploader = await new CloudAudioUpload(lib, { cloudAuth: auth, enabled: true }).init(); f.batches.upload = uploader; return uploader; } };
}
test('actual intent module persists stable IDs without payload, validates source and DB-first forget', async (t) => {
    const x = await actualUploadFixture(t), { f } = x, { items } = await f.create();
    await f.batches.prepareItem(f.who, items[0].itemId);
    const r = stored(f, items[0].itemId), a = attempt(f, r);
    assert.deepEqual((await fs.readdir(x.uploader.dir)).sort(), ['intents.json']);
    assert.equal(x.uploader.lookupByClientRequestId(r.clientRequestId).id, r.intentId);
    await x.restart();
    await f.batches.prepareItem(f.who, r.itemId);
    assert.equal(x.uploader.jobs.length, 1);
    assert.equal(x.uploader.jobs[0].id, r.intentId);
    await assert.rejects(x.uploader.forgetVerified({ intentId: r.intentId, clientRequestId: r.clientRequestId }, f.receipt(r, a), () => null), { code: 'UPLOAD_STATE' });
    const receipt = f.receipt(r, a);
    await f.batches.recordReceipt(f.who, r.itemId, a.attemptId, receipt);
    assert.equal(x.uploader.jobs.length, 0);
    assert.equal(stored(f, r.itemId).receipt.receiptId, receipt.receiptId);
    await x.restart();
    assert.equal(x.uploader.jobs.length, 0);
    assert.equal(JSON.parse(await fs.readFile(path.join(x.uploader.dir, 'intents.json'), 'utf8')).length, 0);
});
test('actual module reuses fsynced snapshot after JSON-save failure, rejects changed source', async (t) => {
    const x = await actualUploadFixture(t), { f } = x, { items } = await f.create();
    await f.batches.prepareItem(f.who, items[0].itemId);
    const r = stored(f, items[0].itemId), j = x.uploader.jobs[0];
    j.status = 'PENDING';
    j.state = 'ready';
    await x.uploader.save();
    await x.uploader.releasePayloadForApproval(j.id);
    assert.equal(j.payloadReleased, true);
    j.status = 'APPROVED';
    await x.uploader.save();
    const save = x.uploader.save.bind(x.uploader);
    x.uploader.save = async () => { throw Object.assign(Error('synthetic fsync failure'), { code: 'CRASH_TEST' }); };
    await assert.rejects(x.uploader.rebuildPayload(j.id), { code: 'CRASH_TEST' });
    x.uploader.save = save;
    // Simulate a filesystem/JSON adjacent crash explicitly with the valid private payload left durable.
    await fs.writeFile(path.join(x.uploader.dir, 'payload-' + j.id), await fs.readFile(x.file), { mode: 0o600 });
    await x.restart();
    assert.equal(x.uploader.jobs[0].payloadReleased, true);
    await x.uploader.rebuildPayload(j.id);
    assert.equal(x.uploader.jobs[0].payloadReleased, false);
    assert.equal(crypto.createHash('sha256').update(await fs.readFile(path.join(x.uploader.dir, 'payload-' + j.id))).digest('hex'), r.sha256);
    await fs.writeFile(x.file, Buffer.alloc(4096, 23));
    await assert.rejects(f.batches.prepareItem(f.who, r.itemId), { code: 'SOURCE_CHANGED' });
    assert.equal(x.uploader.jobs.length, 1);
});
test('actual prepare save failure retries same memory IDs through a fresh durable save', async (t) => {
    const x = await actualUploadFixture(t), { f } = x, { items } = await f.create();
    const save = x.uploader.save.bind(x.uploader);
    let once = true;
    x.uploader.save = async () => { if (once) {
        once = false;
        throw Object.assign(Error('synthetic save failure'), { code: 'CRASH_TEST' });
    } return save(); };
    await assert.rejects(f.batches.prepareItem(f.who, items[0].itemId), { code: 'CRASH_TEST' });
    const before = stored(f, items[0].itemId);
    await f.batches.prepareItem(f.who, before.itemId);
    await x.restart();
    assert.equal(x.uploader.jobs[0].id, before.intentId);
    assert.equal(x.uploader.jobs[0].clientRequestId, before.clientRequestId);
    assert.equal(x.uploader.jobs.length, 1);
});
test('cross-batch active claim rejects overlap; protocol denial or auth change cannot create an intent', async (t) => {
    const f = await sqliteFixture(t, rows(1)), one = await f.create(), two = await f.create();
    f.batches.beginAttempt(f.who, one.items[0].itemId);
    assert.throws(() => f.batches.beginAttempt(f.who, two.items[0].itemId), { code: 'ACTIVE_ITEM_EXISTS' });
    assert.equal(stored(f, two.items[0].itemId).currentAttemptId, null);
    f.batches.authorize = async () => ({ canCreateUploads: false, classification: 'NEW' });
    await assert.rejects(f.batches.prepareItem(f.who, one.items[0].itemId), { code: 'PROTOCOL_UPDATE_REQUIRED' });
    assert.equal(f.upload.jobs.size, 0);
    f.batches.authorize = async () => { f.who = { ...f.who, epoch: 2 }; return { canCreateUploads: true, classification: 'NEW' }; };
    const before = f.who;
    await assert.rejects(f.batches.prepareItem(before, one.items[0].itemId), { code: 'AUTH_CHANGED' });
    assert.equal(f.upload.jobs.size, 0);
});
test('terminal stop with no in-flight work is durably STOPPED; unknown SHA is never executed', async (t) => {
    const source = rows(1);
    source[0].sha256 = null;
    const f = await sqliteFixture(t, source), { b, items } = await f.create();
    assert.equal(items[0].state, 'NEEDS_CONFIRMATION');
    await assert.rejects(f.batches.prepareItem(f.who, items[0].itemId), { code: 'HASH_REQUIRED' });
    assert.equal(f.upload.jobs.size, 0);
    const result = f.batches.command(f.who, b.batchId, { clientCommandId: uuid(), expectedVersion: b.version, action: 'stop' });
    assert.equal(result.state, 'STOPPED');
    f.reopen();
    assert.equal(f.batches.summary(f.who, b.batchId).state, 'STOPPED');
});
test('actual module enforces 50 active intents; durable receipt cleanup opens one slot without replacing blocked IDs', async t => {
    const x = await actualUploadFixture(t), { f } = x, { items } = await f.create();
    await f.batches.prepareItem(f.who, items[0].itemId);
    const row = stored(f, items[0].itemId), a = attempt(f, row), meta = { assetId: row.assetId, sha256: row.sha256, ...row.metadata };
    for (let i = 1; i < 50; i++) await x.uploader.prepareWithIdentity({ intentId: uuid(), clientRequestId: uuid() }, row.sourceVersion, meta);
    const blocked = { intentId: uuid(), clientRequestId: uuid() };
    await assert.rejects(x.uploader.prepareWithIdentity(blocked, row.sourceVersion, meta), { code: 'UPLOAD_LIMIT' });
    await x.restart(); assert.equal(x.uploader.jobs.length, 50);
    await f.batches.recordReceipt(f.who, row.itemId, a.attemptId, f.receipt(row, a));
    const next = await x.uploader.prepareWithIdentity(blocked, row.sourceVersion, meta);
    assert.equal(next.id, blocked.intentId); assert.equal(x.uploader.jobs.length, 50);
    assert.ok((await fs.stat(path.join(x.uploader.dir, 'intents.json'))).size <= 262144);
    assert.equal((await fs.readdir(x.uploader.dir)).filter(n => n.startsWith('payload-')).length, 0);
});
test('same immutable commit replays cleanup after availability changes and survives reopen', async t => {
    const f=await sqliteFixture(t,rows(1)),{b,items}=await f.create();
    await f.batches.prepareItem(f.who,items[0].itemId);
    const row=stored(f,items[0].itemId),a=attempt(f,row),receipt=f.receipt(row,a);
    f.crash='after-receipt-db';
    await assert.rejects(f.batches.recordReceipt(f.who,row.itemId,a.attemptId,receipt),{code:'CRASH_TEST'});
    const historical=stored(f,row.itemId).receipt;assert.equal(Object.hasOwn(historical,'currentAvailability'),false);
    f.crash=null;f.reopen();
    await f.batches.recordReceipt(f.who,row.itemId,a.attemptId,{...receipt,currentAvailability:'UNAVAILABLE'});
    assert.equal(f.upload.jobs.size,0);assert.equal(stored(f,row.itemId).cleanupPending,false);
    assert.deepEqual(stored(f,row.itemId).receipt,historical);assert.deepEqual(stored(f,row.itemId).currentAvailability,{state:'UNAVAILABLE',classification:'UNAVAILABLE'});
    assert.equal(f.batches.summary(f.who,b.batchId).counts.committed,1);
    f.reopen();assert.deepEqual(f.batches.page(f.who,b.batchId).items[0].currentAvailability,{state:'UNAVAILABLE',classification:'UNAVAILABLE'});
});
test('late COMMITTED receipt accepts bounded historical/deleted/review projections without reviving upload rights', async t => {
    for (const state of ['RELEASED','ADMIN_REMOVED','ADMIN_DELETING','ADMIN_DELETED','REMOVAL_PENDING','REMOVED','UNKNOWN','REVIEW_REQUIRED','NEEDS_RECONCILIATION','MISSING','QUARANTINED','FAILED']) {
        const f=await sqliteFixture(t,rows(1)),{b,items}=await f.create();await f.batches.prepareItem(f.who,items[0].itemId);
        const row=stored(f,items[0].itemId),a=attempt(f,row),receipt={...f.receipt(row,a),currentAvailability:state};
        await f.batches.recordReceipt(f.who,row.itemId,a.attemptId,receipt);
        assert.equal(stored(f,row.itemId).state,'COMMITTED');assert.equal(stored(f,row.itemId).currentAvailability.state,state);
        assert.equal(f.batches.summary(f.who,b.batchId).state,'COMPLETED');
        assert.equal(f.preview.page(f.who,f.store.get('cloud_upload_batches',{batchId:b.batchId}).previewId).items[0].classification,'UNKNOWN');
        assert.equal(f.upload.jobs.size,0);assert.equal(f.batches.summary(f.who,b.batchId).counts.uploaded,1);
    }
});
test('availability projection rejects arbitrary strings and historical receipt facts still conflict', async t => {
    const f=await sqliteFixture(t,rows(1)),{items}=await f.create();await f.batches.prepareItem(f.who,items[0].itemId);
    const row=stored(f,items[0].itemId),a=attempt(f,row),receipt=f.receipt(row,a);
    await f.batches.recordReceipt(f.who,row.itemId,a.attemptId,receipt);
    const historical=stored(f,row.itemId).receipt;
    for (const currentAvailability of ['CAN_UPLOAD','__proto__','anything',{state:'AVAILABLE'}]) await assert.rejects(f.batches.recordReceipt(f.who,row.itemId,a.attemptId,{...receipt,currentAvailability}),{code:'RECEIPT_INVALID'});
    for (const patch of [{receiptId:uuid()},{canonicalRequestId:uuid()},{attemptId:uuid()},{shareId:uuid()},{blobId:uuid()},{sha256:'c'.repeat(64)},{verifiedBytes:33},{storageGeneration:2},{admissionEpoch:1},{mode:'reused'},{committedAt:'2026-10-27T00:00:00Z'}]) {
        await assert.rejects(f.batches.recordReceipt(f.who,row.itemId,a.attemptId,{...receipt,...patch,currentAvailability:'ADMIN_DELETED'}),e=>['RECEIPT_CONFLICT','RECEIPT_INVALID'].includes(e.code));
        assert.deepEqual(stored(f,row.itemId).receipt,historical);
    }
});
test('first-candidate receipt decoration remains byte-for-byte historical while mutable projection recovers', async t => {
    const f=await sqliteFixture(t,rows(1)),{items}=await f.create();await f.batches.prepareItem(f.who,items[0].itemId);
    const row=stored(f,items[0].itemId),a=attempt(f,row),receipt=f.receipt(row,a);
    f.crash='after-receipt-db';await assert.rejects(f.batches.recordReceipt(f.who,row.itemId,a.attemptId,receipt),{code:'CRASH_TEST'});f.crash=null;
    // Disposable SQL fixture represents the first frozen candidate's persisted format.
    const prior=stored(f,row.itemId),legacy={...prior.receipt,currentAvailability:'AVAILABLE'};
    prior.receipt=legacy;delete prior.currentAvailability;
    f.db.prepare('UPDATE cloud_upload_batch_items SET receipt_json=?,record_json=? WHERE item_id=?').run(JSON.stringify(legacy),JSON.stringify(prior),row.itemId);
    f.reopen();await f.batches.recordReceipt(f.who,row.itemId,a.attemptId,{...receipt,currentAvailability:'ADMIN_DELETED'});
    assert.deepEqual(stored(f,row.itemId).receipt,legacy);assert.deepEqual(stored(f,row.itemId).currentAvailability,{state:'ADMIN_DELETED',classification:'HISTORICAL'});
    assert.equal(stored(f,row.itemId).cleanupPending,false);assert.equal(f.upload.jobs.size,0);
});
test('bounded keyset recovery reaches active work beyond 5001 historical batches and remains restart-safe', async t => {
    const f=await sqliteFixture(t,rows(1)),{b,items}=await f.create();await f.batches.prepareItem(f.who,items[0].itemId);
    const batch=f.store.get('cloud_upload_batches',{batchId:b.batchId}),item=stored(f,items[0].itemId),a=attempt(f,item);
    const target='ffffffff-ffff-4fff-8fff-ffffffffffff',targetItem=uuid(),targetAttempt=uuid();
    f.store.transaction(()=>{
        for(let n=0;n<5001;n++)f.store.insert('cloud_upload_batches',{...batch,batchId:fixedId(10000+n),clientCommandId:uuid(),state:'STOPPED',stopRequested:true});
        f.store.insert('cloud_upload_batches',{...batch,batchId:target,clientCommandId:uuid(),state:'RUNNING'});
        f.store.insert('cloud_upload_item_attempts',{...a,itemId:targetItem,attemptId:targetAttempt,intentId:uuid(),clientRequestId:uuid()});
        f.store.insert('cloud_upload_batch_items',{...item,itemId:targetItem,batchId:target,currentAttemptId:targetAttempt});
    });
    const list=f.store.list.bind(f.store);let pages=0;
    f.store.list=(table,where,options)=>{if(table==='cloud_upload_batches'){pages++;assert.equal(options.limit,100);assert.equal(options.order,'batchId');}return list(table,where,options);};
    assert.equal(f.batches.recover(f.who).recovered,2);assert.ok(pages>50);
    assert.equal(f.store.get('cloud_upload_batches',{batchId:target}).state,'PAUSED');assert.equal(stored(f,targetItem).state,'RECONCILING');
    assert.equal(stored(f,targetItem).currentAttemptId,targetAttempt);
    f.reopen();f.batches.recover(f.who);assert.equal(stored(f,targetItem).currentAttemptId,targetAttempt);assert.equal(f.store.get('cloud_upload_batches',{batchId:fixedId(10000)}).state,'STOPPED');
});
test('final forget JSON failure stays pending until absence is durably saved, including same-process retry and restart', async t => {
    const x=await actualUploadFixture(t),{f}=x,{b,items}=await f.create();await f.batches.prepareItem(f.who,items[0].itemId);
    const row=stored(f,items[0].itemId),a=attempt(f,row),receipt=f.receipt(row,a),save=x.uploader.save.bind(x.uploader);let writes=0;
    x.uploader.save=async()=>{if(++writes===2||writes===3)throw Object.assign(Error('synthetic final JSON EIO'),{code:'EIO'});return save();};
    const first=await f.batches.recordReceipt(f.who,row.itemId,a.attemptId,receipt);
    assert.equal(first.cleanupPending,true);assert.equal(x.uploader.jobs.length,0);assert.equal(JSON.parse(await fs.readFile(path.join(x.uploader.dir,'intents.json'),'utf8')).length,1);
    const retry=await f.batches.recordReceipt(f.who,row.itemId,a.attemptId,receipt);
    assert.equal(retry.cleanupPending,true);assert.equal(stored(f,row.itemId).cleanupPending,true);
    assert.equal(f.batches.summary(f.who,b.batchId).counts.uploaded,1);
    x.uploader.save=save;
    await f.batches.recordReceipt(f.who,row.itemId,a.attemptId,receipt);
    assert.equal(stored(f,row.itemId).cleanupPending,false);assert.equal(JSON.parse(await fs.readFile(path.join(x.uploader.dir,'intents.json'),'utf8')).length,0);
    await x.restart();assert.equal(x.uploader.jobs.length,0);assert.equal(stored(f,row.itemId).receipt.receiptId,receipt.receiptId);
});
