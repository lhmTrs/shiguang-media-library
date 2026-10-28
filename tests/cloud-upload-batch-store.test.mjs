import test from 'node:test';
import assert from 'node:assert/strict';
import { sqliteFixture, rows, mysqlContract } from './cloud-upload-batch-mysql-fixture.mjs';
import { uuid, canonical } from '../server/cloud-upload-protocol.mjs';
import { mysqlColumnType } from '../server/mysql.mjs';
test('60 and 5000 persisted items are independent from the 50 JSON-intent window', async (t) => { for (const count of [60, 5000]) {
    const f = await sqliteFixture(t, rows(count)), { b, items } = await f.create();
    assert.equal(items.length, count);
    assert.equal(f.upload.jobs.size, 0);
    assert.equal(f.batches.page(f.who, b.batchId).items.length, 100 > count ? count : 100);
    f.reopen();
    assert.equal(f.batches.summary(f.who, b.batchId).totalItems, count);
    assert.equal(f.upload.jobs.size, 0);
} });
test('same command replays its durable result; changed payload conflicts and crash rolls back', async (t) => { const f = await sqliteFixture(t), input = f.input(), p = await f.preview.create(f.who, input); assert.deepEqual(await f.preview.create(f.who, input), p); await assert.rejects(f.preview.create(f.who, { ...input, target: { visibility: 'GROUP', groupId: uuid() } }), { code: 'IDEMPOTENCY_CONFLICT' }); f.crash = 'before-command-receipt'; const failed = f.input(); await assert.rejects(f.preview.create(f.who, failed), { code: 'CRASH_TEST' }); f.crash = null; const count = f.db.prepare('SELECT COUNT(*) n FROM cloud_upload_previews').get().n; assert.equal(count, 1); const replay = await f.preview.create(f.who, failed); assert.ok(replay.previewId); f.reopen(); assert.deepEqual(await f.preview.create(f.who, input), p); });
test('batch commands persist CAS and stop request, unknown work is never reported stopped', async (t) => { const f = await sqliteFixture(t), { b, items } = await f.create(); f.batches.beginAttempt(f.who, items[0].itemId); const command = { clientCommandId: uuid(), expectedVersion: b.version, action: 'stop' }, stopped = f.batches.command(f.who, b.batchId, command); assert.equal(stopped.state, 'STOPPING'); assert.deepEqual(f.batches.command(f.who, b.batchId, command), stopped); assert.equal(f.store.get('cloud_upload_batch_items', { itemId: items[1].itemId }).state, 'CANCELLED'); f.reopen(); f.batches.recover(f.who); assert.equal(f.store.get('cloud_upload_batch_items', { itemId: items[0].itemId }).state, 'RECONCILING'); assert.equal(f.store.get('cloud_upload_batches', { batchId: b.batchId }).state, 'STOPPING'); });
test('MySQL declared indexed types and composite constraints are not LONGTEXT (execution NOT_RUN separately)', () => { const schema = mysqlContract(); assert.equal(schema.length, 8); for (const table of schema) {
    for (const col of table.columns) {
        assert.equal(mysqlColumnType(table.table, { name: col.name, type: 'TEXT' }), col.type);
        if (/(_id|_key|fingerprint|sha256)$/.test(col.name))
            assert.ok(!/TEXT/.test(col.type), col.name);
    }
    assert.ok(table.constraints.some(c => c.startsWith('PRIMARY KEY')));
    assert.ok(table.constraints.some(c => c.includes('9007199254740991')));
} });
