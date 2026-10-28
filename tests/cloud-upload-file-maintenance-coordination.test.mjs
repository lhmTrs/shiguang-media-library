// Private SQLite, original domain/router and local controlled cloud transport.
// File maintenance uses the same exported coordinator as index, with actual
// MissingFiles writes/proof triggers. No full index/UI/SDK TLS/Java/live library.
// Receipt settlement below is a controlled authoritative input, not a real PUT.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import express from 'express';
import { Library } from '../server/library.mjs';
import { reconcileRoot } from '../server/reconcile.mjs';
import { CloudAudioUpload, manualAudioAdmission } from '../server/cloud-audio-upload.mjs';
import { CloudUploadHost } from '../server/cloud-upload-host.mjs';
import { MissingFiles } from '../server/missing-files.mjs';
import { CloudUploadTaskRuntime, CLOUD_UPLOAD_RUNTIME_SCOPE, runFileStatusMaintenance } from '../server/cloud-upload-task-runtime.mjs';

const roots = [], defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const wait = async predicate => { for (let i = 0; i < 1000; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 2)); } assert.fail('condition did not settle'); };
const listen = async app => { const server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r)); return { server, url: `http://127.0.0.1:${server.address().port}` }; };
const close = async server => { server.closeAllConnections(); await new Promise(r => server.close(r)); };
const caps = () => ({ protocol: 2, writeMode: 'READY', canCreateUploads: true,
    requiredSafety: Object.fromEntries(['sqlEligibility', 'contentRowLock', 'generationBindings', 'adminBarrier', 'integrityGate', 'fileOperationFence', 'legacyWriteFence'].map(k => [k, true])),
    optional: { reuse: false }, limits: { maxFileBytes: 256000000, eligibilityMaxItems: 50 } });
async function fixture(t, { omit = null, retainOwner = false } = {}) {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'file-maint-coordination-'))); roots.push({ dir, policy: 'RETAIN_ALL', atSetup: true });
    const lib = await new Library(path.join(dir, 'data'), { directoryClassification: true }).init(); lib.enqueue = () => {};
    const media = path.join(dir, 'own-media'); await fs.mkdir(path.join(media, 'A', 'B'), { recursive: true }); await fs.writeFile(path.join(media, 'A', 'B', 'own.wav'), Buffer.alloc(64, 7));
    const root = await lib.addRoot(media, 'music');
    // Explicit fixture seed scan before runtime exists. No positive proof survives
    // this scan; the runtime subsequently registers and performs its own full scan.
    await reconcileRoot(lib, lib.rootById(root.id), { tagFiles: false });
    const sourceId = randomUUID(); let who = { cloudServiceKey: createHash('sha256').update('https://controlled.invalid').digest('hex'), accountId: randomUUID(), deviceId: randomUUID(), librarySourceId: sourceId, epoch: 1 };
    const control = { permission: true, maintenance: true, activity: true, holdPermission: null, holdDownloadStatus: null, holdCloud: null, calls: [], downloads: { active: 0, queued: 0 } };
    const requestRows = new Map();
    const cloud = express(); cloud.use(express.json());
    cloud.use(async (req, res) => { control.calls.push({ method: req.method, path: req.path }); if (control.holdCloud) await control.holdCloud.promise;
        if (req.path === '/media/upload-capabilities') return res.json({ data: caps() });
        if (req.path === '/media/upload-eligibility') return res.json({ data: req.body.items.map(x => ({ clientItemId: x.clientItemId, classification: 'NEW', selectable: true, stateVersion: 1, admissionEpoch: 0, storageGeneration: null, originalRequestId: null, currentAvailability: 'NOT_COMMITTED', reasonCode: null })) });
        if (req.method === 'POST' && req.path === '/media/upload-requests') {
            const b = req.body, row = { id: randomUUID(), ownerAccountId: who.accountId, requestId: b.requestId, mediaKind: b.mediaKind,
                fileName: b.fileName, declaredBytes: b.bytes, declaredSha256: b.sha256, visibility: b.visibility, groupId: b.groupId,
                category: b.category, subcategory: b.subcategory, status: 'PENDING', version: 1, approvalThresholdBytes: 1,
                createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), reviewedBy: null };
            requestRows.set(b.requestId, { row, attemptId: randomUUID() }); return res.json({ data: row });
        }
        if (req.path.startsWith('/media/upload-request-resolutions/')) {
            const clientRequestId = req.path.split('/').at(-1), r = requestRows.get(clientRequestId);
            if (r) return res.json({ data: { clientRequestId, canonicalRequestId: r.row.id, attemptId: r.attemptId,
                commitState: 'NOT_COMMITTED', receipt: null, currentAvailability: 'NOT_COMMITTED', qualificationVersion: 1,
                admissionEpoch: 0, storageGeneration: null } });
        }
        if (req.path.startsWith('/media/upload-requests/')) {
            const row = [...requestRows.values()].find(r => r.row.id === req.path.split('/').at(-1));
            if (row) return res.json({ data: row.row });
        }
        res.status(404).json({ error: { code: 'CONTROLLED_ROUTE_NOT_IMPLEMENTED' } });
    });
    const remote = await listen(cloud);
    const auth = { config: { origin: 'https://controlled.invalid' }, get epoch() { return who.epoch; }, getState: () => ({ configured: true, state: 'logged-in', accountId: who.accountId, deviceId: who.deviceId, originHost: 'controlled.invalid' }),
        async proxy(method, route, { body, epoch } = {}) { assert.equal(epoch, who.epoch); const response = await fetch(remote.url + route, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) }); const v = await response.json(); if (!response.ok) throw Object.assign(Error(), { code: v.error.code, status: response.status }); return v.data; },
        async uploadAudioContent() { throw Error('CONTENT_NOT_IN_B6_FIXTURE'); } };
    const upload = await new CloudAudioUpload(lib, { cloudAuth: auth, enabled: true }).init();
    const host = await new CloudUploadHost(lib, { upload, sourceId, readMaintenance: async () => ({ known: true, allowed: control.maintenance === true && control.activity === true }) }).init();
    const manual = manualAudioAdmission(async () => { if (control.holdDownloadStatus) await control.holdDownloadStatus.promise; return control.downloads; });
    const missing = new MissingFiles(lib);
    const options = { lib, upload, cloudAuth: auth, host, manualAudioAdmission: manual, currentIdentity: () => who,
        guardLocalRequest: async (req, { write }) => ({ allowed: req.headers.cookie === 'media_session=controlled' && (!write || req.headers['x-local-token'] === 'controlled'), sessionId: 'controlled-session' }),
        readPermission: async () => { if (control.holdPermission) await control.holdPermission.promise; return { known: control.permission !== null, allowed: control.permission }; },
        readMaintenance: async () => ({ known: control.maintenance !== null, allowed: control.maintenance }),
        readActivity: async () => ({ known: control.activity !== null, allowed: control.activity && missing.active === null }),
        assertHostRegistrationCurrent: () => control.permission === true && control.maintenance === true && control.activity === true };
    if (omit) delete options[omit];
    // Instrument actual DB methods only while constructing. No constructor reads.
    const prepare = lib.db.prepare, exec = lib.db.exec; let constructorSql = 0;
    lib.db.prepare = function (...a) { constructorSql++; return prepare.apply(this, a); }; lib.db.exec = function (...a) { constructorSql++; return exec.apply(this, a); };
    let runtime; try { runtime = new CloudUploadTaskRuntime(options); } finally { lib.db.prepare = prepare; lib.db.exec = exec; }
    assert.equal(constructorSql, 0);
    const app = express(); app.use(runtime.basePath, runtime.router); const local = await listen(app);
    const x = { dir, lib, root, upload, auth, host, manual, runtime, control, options, missing, url: local.url,
        maintenance(force = false, work = () => missing.check({ force })) { return runFileStatusMaintenance({ lib, upload, host, manualAudioAdmission: manual, readRuntime: () => runtime }, work); },
        get who() { return { ...who }; }, set who(v) { who = v; },
        async call(method, route, body, headers = {}) { const response = await fetch(local.url + runtime.basePath + route, { method, headers: { Cookie: 'media_session=controlled', ...(body ? { 'Content-Type': 'application/json', 'x-local-token': 'controlled' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, body: await response.json() }; },
        async register() { const assetIds = lib.db.prepare('SELECT id FROM assets ORDER BY id').all().map(r => r.id); assert.equal((await runtime.registerHost({ clientCommandId: randomUUID(), expectedVersion: 0, assetIds })).ready, true); assert.equal((await runtime.admitProof({ mode: 'REGISTER', clientCommandId: randomUUID(), expectedVersion: 0 })).known, true); },
        async full() { const r = await runtime.fullScan({ rootId: root.id, confirmed: true }); assert.equal(r.walkErrors.length, 0); assert.equal(r.conflicts.length, 0); },
        async preview() { const categories = await this.call('GET', '/scope-categories?rootIds=' + root.id); assert.equal(categories.status, 200, JSON.stringify(categories)); const payload = { clientCommandId: randomUUID(), scopes: [{ rootId: root.id, category: null, subcategory: null }], target: { visibility: 'PRIVATE', groupId: null }, categoryOverride: null };
            const issued = await this.call('POST', '/scope-bindings', { ...payload, scopeSchema: 'scope-null-v1', providerBinding: categories.body.data.binding }); assert.equal(issued.status, 200, JSON.stringify(issued));
            const result = await this.call('POST', '/previews', { ...payload, scopeBinding: issued.body.data.scopeBinding }); assert.equal(result.status, 200, JSON.stringify(result)); return result.body.data; },
        async batch(startPaused = false) { const p = await this.preview(); const r = await this.call('POST', '/batches', { clientCommandId: randomUUID(), previewId: p.previewId, expectedPreviewVersion: p.version, manifestFingerprint: p.manifestFingerprint, startPaused, representativeConfirmations: [] }); assert.equal(r.status, 200, JSON.stringify(r)); return r.body.data; },
        startInput() { return { scope: CLOUD_UPLOAD_RUNTIME_SCOPE, queueFingerprint: runtime.queuePlan().queueFingerprint, confirmed: true, automatic: false, recover: false }; },
        async closeServersOnly() { await close(local.server); await close(remote.server); },
        async cleanup() { const settled = await this.runtime.dispose(); assert.equal(settled.closed, true, JSON.stringify(settled)); await close(local.server); await close(remote.server); assert.equal(host.closed, false); assert.equal(upload.disposing, false); assert.equal(lib.db.open, true); await host.dispose(); assert.equal((await upload.dispose()).closed, true); lib.db.close(); } };
    if (!retainOwner) t.after(() => x.cleanup()); return x;
}

const proof = x => x.lib.db.prepare('SELECT state,generation,version,error_code FROM cloud_upload_scan_proofs').all();
const stopped = async (x, batch) => x.runtime.command(batch.batchId, { clientCommandId: randomUUID(),
    expectedVersion: x.runtime.batches.owned(x.who, batch.batchId).version, action: 'stop' });
const deferredResult = r => { assert.equal(r.deferred, true); assert.match(r.code, /^(HOST_BUSY|BUSY|FILE_MAINTENANCE_BUSY|FILE_MAINTENANCE_UNKNOWN)$/); assert.equal('checked' in r, false); };
const commitControlledReceipt = async (x, batch) => {
    const item = x.runtime.batches.rows(batch.batchId)[0], blobId = randomUUID();
    assert.equal(item.state, 'HASHED');
    const result = await x.runtime.batches.recordReceipt(x.who, item.itemId, item.currentAttemptId, {
        receiptId: randomUUID(), clientRequestId: item.clientRequestId, canonicalRequestId: randomUUID(), attemptId: randomUUID(),
        blobId, shareId: randomUUID(), sha256: item.sha256, verifiedBytes: item.declaredBytes, storageGeneration: 1,
        admissionEpoch: 0, mode: 'uploaded', targetMatched: true, committedAt: new Date().toISOString(), currentAvailability: 'AVAILABLE' });
    assert.deepEqual(result, { recorded: true, cleanupPending: false });
    assert.equal(x.upload.jobs.length, 0); assert.equal(x.runtime.batches.owned(x.who, batch.batchId).state, 'COMPLETED');
};
test.after(() => console.log('FILE_MAINTENANCE_ROOTS=' + JSON.stringify({ roots, policy: 'RETAIN_ALL; known fixture resources closed only' })));

test('passive maintenance does not register, capture, initialize schema or ask remote permission', async t => {
    const x = await fixture(t), before = x.lib.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'cloud_upload_%'").all();
    const schema = x.host.schema; x.host.schema = () => { assert.fail('implicit schema'); };
    try {
        assert.equal(x.runtime.captured, null); assert.equal(x.runtime.descriptorValue, null);
        const r = await x.maintenance(); assert.equal(r.checked, 1);
        assert.equal(x.runtime.captured, null); assert.equal(x.runtime.descriptorValue, null);
        assert.deepEqual(x.lib.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'cloud_upload_%'").all(), before);
        assert.equal(x.control.calls.length, 0); assert.equal(x.host.active, 0); assert.equal(x.host.exclusive, false);
    } finally { x.host.schema = schema; }
});

test('real preflight handler holds HOST; automatic and force maintenance cannot write', async t => {
    const x = await fixture(t); await x.register(); await x.full(); const before = proof(x), hold = defer();
    x.control.holdPermission = hold; const preview = x.preview();
    try {
        await wait(() => x.runtime.handle.state().active > 0);
        deferredResult(await x.maintenance()); deferredResult(await x.maintenance(true)); assert.deepEqual(proof(x), before);
    } finally { hold.resolve(); x.control.holdPermission = null; }
    await preview;
});

test('original five-second kickoff crossed while explicit queue is active preserves FULL', async t => {
    const x = await fixture(t); await x.register(); await x.full(); await x.batch(); await x.runtime.start(x.startInput());
    const source = await fs.readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
    assert.match(source, /const kickoff = setTimeout\(check, 5000\)/); // Existing UI timing is unchanged.
    const before = proof(x), timer = new Promise((resolve, reject) => setTimeout(() => x.maintenance().then(resolve, reject), 5000));
    deferredResult(await x.maintenance(true)); deferredResult(await timer);
    assert.deepEqual(proof(x), before); assert.equal(x.control.calls.filter(r => r.path === '/media/upload-requests').length, 0);
});

test('completed first batch then second HASHED and concurrent request keep maintenance out', async t => {
    const x = await fixture(t); await x.register(); await x.full(); const first = await x.batch(); await x.runtime.start(x.startInput());
    await x.runtime.scheduler.tick(); await commitControlledReceipt(x, first);
    const second = await x.batch(); await x.runtime.scheduler.tick();
    assert.equal(x.runtime.batches.rows(second.batchId)[0].state, 'HASHED');
    const before = proof(x); deferredResult(await x.maintenance(true)); assert.deepEqual(proof(x), before);
    const hold = defer(); x.control.holdCloud = hold; const count = x.control.calls.length, tick = x.runtime.scheduler.tick();
    try { await wait(() => x.control.calls.length > count); deferredResult(await x.maintenance()); assert.deepEqual(proof(x), before); }
    finally { hold.resolve(); x.control.holdCloud = null; }
    await tick;
    assert.equal(x.runtime.batches.rows(second.batchId)[0].state, 'WAITING_APPROVAL');
    assert.equal(x.control.calls.filter(r => r.path === '/media/upload-requests').length, 1);
    assert.deepEqual(proof(x), before);
});

test('dispatch gap and unstarted nonterminal batch are not idle; real stop restores maintenance', async t => {
    const x = await fixture(t); await x.register(); await x.full(); const batch = await x.batch(), before = proof(x);
    assert.equal(x.runtime.scheduler.started, false); deferredResult(await x.maintenance());
    await x.runtime.start(x.startInput()); assert.equal(x.runtime.scheduler.inflight, null);
    assert.equal(x.runtime.scheduler.dispatchState().settled, true); deferredResult(await x.maintenance(true));
    assert.deepEqual(proof(x), before); await stopped(x, batch);
    assert.equal(x.runtime.batches.owned(x.who, batch.batchId).state, 'STOPPED');
    const r = await x.maintenance(true); assert.equal(r.deferred, undefined); assert.equal(r.checked, 1);
    assert.equal(proof(x)[0].state, 'UNKNOWN'); assert.equal(proof(x)[0].error_code, 'MUTATION');
});

test('maintenance first owns actual HOST/manual gate through its awaited writes; dispatch stays closed', async t => {
    const x = await fixture(t); await x.register(); await x.full(); await x.runtime.start(x.startInput());
    const entered = defer(), hold = defer(), before = proof(x);
    const maintenance = x.maintenance(true, async () => { entered.resolve(); await hold.promise; return x.missing.check({ force: true }); });
    try {
        await entered.promise; assert.equal(x.host.exclusive, true); assert.equal(x.host.active, 1);
        const tick = await x.runtime.scheduler.tick(); assert.equal(tick.processed, false); assert.equal(tick.code, 'MAINTENANCE_BUSY');
        await assert.rejects(x.manual.download(async () => {}), { code: 'BUSY' });
        deferredResult(await x.maintenance(true)); assert.deepEqual(proof(x), before);
        assert.equal(x.control.calls.length, 0);
    } finally { hold.resolve(); }
    assert.equal((await maintenance).checked, 1); assert.equal(x.host.active, 0); assert.equal(x.host.exclusive, false);
    await x.manual.download(async () => {}); assert.equal(proof(x)[0].state, 'UNKNOWN');
});

test('true source change is still rejected during deferred maintenance, with zero remote request', async t => {
    const x = await fixture(t); await x.register(); await x.full(); const batch = await x.batch(); await x.runtime.start(x.startInput());
    await x.runtime.scheduler.tick(); const item = x.runtime.batches.rows(batch.batchId)[0]; assert.equal(item.state, 'HASHED');
    deferredResult(await x.maintenance(true)); await fs.writeFile(x.lib.asset(item.representativeAssetId).path, Buffer.alloc(65, 9));
    await x.runtime.scheduler.tick(); const current = x.runtime.batches.rows(batch.batchId)[0];
    assert.equal(current.lastCode, 'SOURCE_CHANGED'); assert.equal(x.control.calls.filter(r => r.path === '/media/upload-requests').length, 0);
});

test('started scheduler with empty queue and completed settled history does not starve checks', async t => {
    const x = await fixture(t); await x.register(); await x.full(); await x.runtime.start(x.startInput());
    assert.equal((await x.maintenance(true)).checked, 1); await x.full();
    const batch = await x.batch(); await x.runtime.scheduler.tick(); await commitControlledReceipt(x, batch);
    assert.equal(x.runtime.scheduler.started, true); assert.equal((await x.maintenance(true)).checked, 1);
    assert.equal((await x.maintenance()).deferred, undefined); // Original cache result is still permitted.
    assert.equal(x.host.active, 0); assert.equal(x.runtime.scheduler.state().timers, 0);
});

test('terminal projection alone cannot release retained cleanup; controlled damaged ledger remains closed', async t => {
    const x = await fixture(t); await x.register(); await x.full(); const batch = await x.batch(); await x.runtime.start(x.startInput());
    await x.runtime.scheduler.tick(); await commitControlledReceipt(x, batch);
    // Explicit fixture corruption, not a cleanup implementation or remote proof.
    const item = x.runtime.batches.rows(batch.batchId)[0];
    x.runtime.store.update('cloud_upload_batch_items', item, { cleanupPending: true });
    const before = proof(x); deferredResult(await x.maintenance(true)); assert.deepEqual(proof(x), before);
    const current = x.runtime.batches.rows(batch.batchId)[0]; x.runtime.store.update('cloud_upload_batch_items', current, { cleanupPending: false, resourcesRetained: true });
    deferredResult(await x.maintenance(true)); assert.deepEqual(proof(x), before);
});

test('unknown identity, binding, dispatch lease and read failure cannot release or mutate owner', async t => {
    const x = await fixture(t); await x.register(); await x.full(); const before = proof(x), captured = x.runtime.captured;
    const who = x.who; x.who = { ...who, epoch: who.epoch + 1 };
    deferredResult(await x.maintenance(true)); assert.equal(x.runtime.poisoned, false); assert.equal(x.runtime.captured, captured); x.who = who;
    const actual = x.runtime.host; x.runtime.host = {};
    deferredResult(await x.maintenance(true)); x.runtime.host = actual;
    const registration = x.host.registration; x.host.registration = null;
    deferredResult(await x.maintenance(true)); x.host.registration = registration;
    x.runtime.scheduler.dispatchLease = { token: null, unknown: true };
    deferredResult(await x.maintenance(true)); assert.equal(x.runtime.scheduler.dispatchLease.unknown, true); x.runtime.scheduler.dispatchLease = null;
    const prepare = x.lib.db.prepare; x.lib.db.prepare = () => { throw Error('controlled read failure'); };
    try { deferredResult(await x.maintenance(true)); } finally { x.lib.db.prepare = prepare; }
    assert.deepEqual(proof(x), before); assert.equal(x.host.active, 0); assert.equal((await x.maintenance(true)).checked, 1);
});

test('awaited admission reads the latest actual runtime; work errors never masquerade as prewrite deferral', async t => {
    const x = await fixture(t); await x.register(); await x.full(); const hold = defer(); x.control.holdDownloadStatus = hold;
    let current = null, writes = 0;
    const result = runFileStatusMaintenance({ lib: x.lib, upload: x.upload, host: x.host, manualAudioAdmission: x.manual,
        readRuntime: () => current }, () => { writes++; });
    current = {}; hold.resolve(); deferredResult(await result); assert.equal(writes, 0); x.control.holdDownloadStatus = null;
    const error = Object.assign(Error('controlled post-write BUSY'), { code: 'BUSY' });
    await assert.rejects(x.maintenance(true, () => { writes++; throw error; }), e => e === error);
    assert.equal(writes, 1); assert.equal(x.host.exclusive, false);
});

test('registered history without attached owner stays unknown; settled ordinary upload history does not hold queue', async t => {
    const x = await fixture(t); await x.register(); await x.full(); const before = proof(x);
    deferredResult(await runFileStatusMaintenance({ lib: x.lib, upload: x.upload, host: x.host,
        manualAudioAdmission: x.manual, readRuntime: () => null }, () => assert.fail('unknown owner write')));
    assert.deepEqual(proof(x), before);
    // Ordinary terminal history is not a batch owner. No remote work is faked.
    x.upload.jobs.push({ state: 'completed' });
    try { assert.equal((await x.maintenance(true)).checked, 1); } finally { x.upload.jobs.pop(); }
});

test('uncoordinated real MissingFiles writer invalidates FULL and reproduces silent dispatch refusal', async t => {
    const x = await fixture(t); await x.register(); await x.full(); await x.batch(); await x.runtime.start(x.startInput());
    assert.equal(proof(x)[0].state, 'COMPLETE');
    // Baseline counterexample: intentionally bypass coordinator only in fixture.
    await x.missing.check({ force: true }); assert.equal(proof(x)[0].state, 'UNKNOWN');
    const result = await x.runtime.scheduler.tick(); assert.equal(result.processed, false); assert.equal(result.code, 'MAINTENANCE_BUSY');
    assert.equal(x.control.calls.filter(r => r.path === '/media/upload-requests').length, 0);
});

test('index uses coordinator for the original ordinary endpoint and leaves UI/proof/source untouched', async () => {
    const source = await fs.readFile(new URL('../server/index.mjs', import.meta.url), 'utf8');
    assert.match(source, /const fileStatusMaintenance = req.method === "POST" && route === "\/api\/maintenance\/files"/);
    assert.match(source, /fileStatusMaintenance \? fileWork\(\)/);
    assert.match(source, /readRuntime: \(\) => taskRuntime/);
    assert.match(source, /app.post\("\/api\/maintenance\/files", asyncRoute\(async \(req, res\) => \{\s*res.json\(await missingFiles.check\(\{ force: req.body.force === true, dryRun: req.body.dryRun === true \}\)\)/);
});
