// Explicit injection only for MySQL. Never reads any connection file or starts a database/service.
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudUploadBatchStore, UPLOAD_TABLES, uploadMysqlColumnType, uploadConstraints } from '../server/cloud-upload-batch-store.mjs';
import { CloudUploadPreview } from '../server/cloud-upload-preview.mjs';
import { CloudUploadBatches } from '../server/cloud-upload-batches.mjs';
import { uuid, fingerprint, canonical, fail } from '../server/cloud-upload-protocol.mjs';
export const fixedId = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
export function rows(count, { sameSha = false, conflict = false, start = 1 } = {}) { return Array.from({ length: count }, (_, i) => ({ assetId: fixedId(i + start + 100), rootId: fixedId(9), sourceVersion: { rootIdentity: '1:2', dev: 1, ino: 100 + i + start, size: 32, mtimeMs: 100, ctimeMs: 100 }, mediaKind: 'MUSIC', fileName: conflict ? 'file-' + i + '.wav' : 'file.wav', category: 'A', subcategory: 'B', target: { visibility: 'PRIVATE', groupId: null }, sha256: sameSha ? 'a'.repeat(64) : fingerprint(i + start), declaredBytes: 32 })); }
export function fakeUpload(snapshot = []) { const jobs = new Map(snapshot.map(j => [j.id, j])), events = []; let maximum = jobs.size; return { jobs, events, get maximum() { return maximum; }, lookupByClientRequestId(client) { return [...jobs.values()].find(j => j.clientRequestId === client) || null; }, async prepareWithIdentity(ids, sourceVersion, metadata) { const old = jobs.get(ids.intentId), binding = fingerprint({ ids, sourceVersion, metadata }); if (old) {
        if (old.binding !== binding)
            fail('UPLOAD_STATE');
        return old;
    } if (jobs.size >= 50)
        fail('UPLOAD_LIMIT'); const j = { id: ids.intentId, clientRequestId: ids.clientRequestId, binding, state: 'prepared' }; jobs.set(j.id, j); maximum = Math.max(maximum, jobs.size); events.push(['intent', j.id]); return j; }, async forgetVerified(ids, receipt, readCommitted) { if (canonical(receipt) !== canonical(readCommitted()))
        throw Error('receipt must be durable first'); events.push(['forget', ids.intentId]); jobs.delete(ids.intentId); return { removed: true }; } }; }
export async function sqliteFixture(t, initialRows = rows(2)) {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'uq01-fixture-'))), file = path.join(dir, 'library.sqlite');
    let who = { cloudServiceKey: 'b'.repeat(64), accountId: fixedId(1), deviceId: fixedId(2), librarySourceId: fixedId(3), epoch: 1 }, clock = 1000, crash = null, sourceRows = initialRows, upload = fakeUpload(), db, store, preview, batches;
    const currentIdentity = () => ({ ...who });
    const f = { dir, file, get db() { return db; }, get store() { return store; }, get preview() { return preview; }, get batches() { return batches; }, get who() { return currentIdentity(); }, get upload() { return upload; }, set who(v) { who = v; }, set clock(v) { clock = v; }, set crash(v) { crash = v; }, set sourceRows(v) { sourceRows = v; }, input() { return { clientCommandId: uuid(), scopes: [{ rootId: fixedId(9), category: null, subcategory: null }], target: { visibility: 'PRIVATE', groupId: null }, categoryOverride: null }; }, async create() { const p = await preview.create(currentIdentity(), this.input()); const b = batches.create(currentIdentity(), { clientCommandId: uuid(), previewId: p.previewId, expectedPreviewVersion: p.version, manifestFingerprint: p.manifestFingerprint, startPaused: false, representativeConfirmations: [] }); return { p, b, items: store.list('cloud_upload_batch_items', { batchId: b.batchId }, { order: 'ordinal' }) }; }, reopen() { db.close(); upload = fakeUpload([...upload.jobs.values()]); open(); }, receipt(item, attempt, mode = 'uploaded') { return { receiptId: uuid(), clientRequestId: attempt.clientRequestId, canonicalRequestId: uuid(), attemptId: uuid(), blobId: uuid(), shareId: uuid(), sha256: item.sha256, verifiedBytes: item.declaredBytes, storageGeneration: 1, admissionEpoch: 0, mode, targetMatched: mode !== 'already_present', committedAt: '2026-10-26T00:00:00Z', currentAvailability: 'AVAILABLE' }; } };
    function open() { db = new Database(file); store = new CloudUploadBatchStore(db, { clock: () => clock, hook: point => { if (crash === point)
            throw Object.assign(Error('synthetic crash'), { code: 'CRASH_TEST' }); } }).init(); preview = new CloudUploadPreview(store, { currentIdentity, snapshotScope: async () => ({ scanComplete: true, offline: false, rootRevision: 1, scanCompletedAt: 100, items: sourceRows }) }); batches = new CloudUploadBatches(store, preview, { currentIdentity, upload, authorize: async () => ({ canCreateUploads: true, classification: 'NEW' }), hook: point => { if (crash === point)
            throw Object.assign(Error('synthetic crash'), { code: 'CRASH_TEST' }); } }); }
    open();
    t?.after(async () => { db.close(); await fs.rm(dir, { recursive: true, force: true }); });
    return f;
}
export function mysqlContract() { return Object.entries(UPLOAD_TABLES).map(([table, d]) => ({ table, columns: Object.keys(d.columns).map(k => ({ name: k.replace(/[A-Z]/g, x => '_' + x.toLowerCase()), type: uploadMysqlColumnType(table, { name: k.replace(/[A-Z]/g, x => '_' + x.toLowerCase()) }) })), constraints: uploadConstraints(table) })); }
export function runInjectedMysqlFixture(db) { if (db.kind !== 'mysql')
    throw Error('requires explicitly authorized disposable MySQL adapter'); const store = new CloudUploadBatchStore(db).init(); return { store, status: 'SCHEMA_CREATED_ONLY' }; }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    console.log(JSON.stringify({ status: 'NOT_RUN', reason: 'No authorized disposable MySQL environment supplied; SQLite evidence is separate', typedTables: mysqlContract().length }));
