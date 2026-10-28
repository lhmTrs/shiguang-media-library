// Private SQLite/real domain/real HTTP adapter. CloudAuth transport, remote
// cloud, local session and permission/receiver/migration snapshots are controlled
// fixtures. No Java, actual CloudAuth SDK TLS login, full app or live library.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import Database from 'better-sqlite3';
import { Library } from '../server/library.mjs';
import { reconcileRoot } from '../server/reconcile.mjs';
import { CloudAudioUpload, manualAudioAdmission } from '../server/cloud-audio-upload.mjs';
import { CloudUploadHost } from '../server/cloud-upload-host.mjs';
import { CloudUploadTaskRuntime, CLOUD_UPLOAD_RUNTIME_SCOPE } from '../server/cloud-upload-task-runtime.mjs';

const roots = [], defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const wait = async predicate => { for (let i = 0; i < 1000; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 2)); } assert.fail('condition did not settle'); };
const listen = async app => { const server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r)); return { server, url: `http://127.0.0.1:${server.address().port}` }; };
const close = async server => { server.closeAllConnections(); await new Promise(r => server.close(r)); };
const caps = () => ({ protocol: 2, writeMode: 'READY', canCreateUploads: true,
    requiredSafety: Object.fromEntries(['sqlEligibility', 'contentRowLock', 'generationBindings', 'adminBarrier', 'integrityGate', 'fileOperationFence', 'legacyWriteFence'].map(k => [k, true])),
    optional: { reuse: false }, limits: { maxFileBytes: 256000000, eligibilityMaxItems: 50 } });
async function fixture(t, { omit = null, retainOwner = false } = {}) {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'uq04b6-'))); roots.push({ dir, policy: 'RETAIN_ALL', atSetup: true });
    const lib = await new Library(path.join(dir, 'data'), { directoryClassification: true }).init(); lib.enqueue = () => {};
    const media = path.join(dir, 'own-media'); await fs.mkdir(path.join(media, 'A', 'B'), { recursive: true }); await fs.writeFile(path.join(media, 'A', 'B', 'own.wav'), Buffer.alloc(64, 7));
    const root = await lib.addRoot(media, 'music');
    // Explicit fixture seed scan before runtime exists. No positive proof survives
    // this scan; the runtime subsequently registers and performs its own full scan.
    await reconcileRoot(lib, lib.rootById(root.id), { tagFiles: false });
    const sourceId = randomUUID(); let who = { cloudServiceKey: 'b'.repeat(64), accountId: randomUUID(), deviceId: randomUUID(), librarySourceId: sourceId, epoch: 1 };
    const control = { permission: true, maintenance: true, activity: true, holdPermission: null, holdDownloadStatus: null, holdCloud: null, calls: [], downloads: { active: 0, queued: 0 } };
    const cloud = express(); cloud.use(express.json());
    cloud.use(async (req, res) => { control.calls.push({ method: req.method, path: req.path }); if (control.holdCloud) await control.holdCloud.promise;
        if (req.path === '/media/upload-capabilities') return res.json({ data: caps() });
        if (req.path === '/media/upload-eligibility') return res.json({ data: req.body.items.map(x => ({ clientItemId: x.clientItemId, classification: 'NEW', selectable: true, stateVersion: 1, admissionEpoch: 0, storageGeneration: null, originalRequestId: null, currentAvailability: 'NOT_COMMITTED', reasonCode: null })) });
        res.status(404).json({ error: { code: 'CONTROLLED_ROUTE_NOT_IMPLEMENTED' } });
    });
    const remote = await listen(cloud);
    const auth = { get epoch() { return who.epoch; }, getState: () => ({ configured: true, state: 'logged-in', accountId: who.accountId, deviceId: who.deviceId, originHost: 'controlled.invalid' }),
        async proxy(method, route, { body, epoch } = {}) { assert.equal(epoch, who.epoch); const response = await fetch(remote.url + route, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) }); const v = await response.json(); if (!response.ok) throw Object.assign(Error(), { code: v.error.code, status: response.status }); return v.data; },
        async uploadAudioContent() { throw Error('CONTENT_NOT_IN_B6_FIXTURE'); } };
    const upload = await new CloudAudioUpload(lib, { cloudAuth: auth, enabled: true }).init();
    const host = await new CloudUploadHost(lib, { upload, sourceId, readMaintenance: async () => ({ known: true, allowed: control.maintenance === true && control.activity === true }) }).init();
    const manual = manualAudioAdmission(async () => { if (control.holdDownloadStatus) await control.holdDownloadStatus.promise; return control.downloads; });
    const options = { lib, upload, cloudAuth: auth, host, manualAudioAdmission: manual, currentIdentity: () => who,
        guardLocalRequest: async (req, { write }) => ({ allowed: req.headers.cookie === 'media_session=controlled' && (!write || req.headers['x-local-token'] === 'controlled'), sessionId: 'controlled-session' }),
        readPermission: async () => { if (control.holdPermission) await control.holdPermission.promise; return { known: control.permission !== null, allowed: control.permission }; },
        readMaintenance: async () => ({ known: control.maintenance !== null, allowed: control.maintenance }),
        readActivity: async () => ({ known: control.activity !== null, allowed: control.activity }),
        assertHostRegistrationCurrent: () => control.permission === true && control.maintenance === true && control.activity === true };
    if (omit) delete options[omit];
    // Instrument actual DB methods only while constructing. No constructor reads.
    const prepare = lib.db.prepare, exec = lib.db.exec; let constructorSql = 0;
    lib.db.prepare = function (...a) { constructorSql++; return prepare.apply(this, a); }; lib.db.exec = function (...a) { constructorSql++; return exec.apply(this, a); };
    let runtime; try { runtime = new CloudUploadTaskRuntime(options); } finally { lib.db.prepare = prepare; lib.db.exec = exec; }
    assert.equal(constructorSql, 0);
    const app = express(); app.use(runtime.basePath, runtime.router); const local = await listen(app);
    const x = { dir, lib, root, upload, auth, host, manual, runtime, control, options, url: local.url,
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
const tables = x => x.lib.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'cloud_upload_%' ORDER BY name").all();
test.after(() => console.log('UQ04B6_ROOTS=' + JSON.stringify({ roots, after: 'RETAIN_ALL; close known resources only; no after fixture inventory/removal' })));

test('passive construction, status and unregistered HTTP reads do not create upload tables, scan or dispatch', async t => {
    const x = await fixture(t), before = tables(x); assert.deepEqual(before, []);
    for (let i = 0; i < 2; i++) { assert.equal((await x.runtime.status()).host.phase, 'NOT_REGISTERED'); assert.equal((await x.call('GET', '/scope-roots')).status, 503); }
    assert.deepEqual(tables(x), before); assert.equal(x.control.calls.length, 0); assert.deepEqual(x.runtime.scheduler.state(), { started: false, closing: false, closed: false, inflight: 0, timers: 0 });
});
test('explicit host/proof registration, actual full, raw HTTP bound preview and queue do not start scheduler', async t => {
    const x = await fixture(t); await x.register(); assert.equal(tables(x).filter(r => !r.name.startsWith('cloud_upload_scan_')).length, 8);
    const cat = await x.call('GET', '/scope-categories?rootIds=' + x.root.id); assert.equal(cat.status, 200);
    const payload = { clientCommandId: randomUUID(), scopeSchema: 'scope-null-v1', providerBinding: cat.body.data.binding, scopes: [{ rootId: x.root.id, category: null, subcategory: null }], target: { visibility: 'PRIVATE', groupId: null }, categoryOverride: null };
    assert.notEqual((await x.call('POST', '/scope-bindings', payload)).status, 200);
    await x.full(); const batch = await x.batch(); assert.equal(batch.totalItems, 1); assert.equal(x.runtime.scheduler.started, false); assert.equal(x.control.calls.length, 0);
    assert.equal(x.runtime.manualAudioAdmission, x.manual); assert.equal(x.runtime.remote.auth, x.auth); assert.equal(x.runtime.proof.db, x.lib.db); assert.equal(x.runtime.batches.upload, x.upload);
});
test('missing permission/maintenance/activity callbacks and unknown snapshots stay closed without DDL', async t => {
    for (const omit of ['readPermission', 'readMaintenance', 'readActivity']) { const x = await fixture(t, { omit }); assert.equal((await x.runtime.status()).known, false); await assert.rejects(x.register(), { code: 'RUNTIME_GATE_UNKNOWN' }); assert.deepEqual(tables(x), []); }
    const x = await fixture(t); for (const key of ['permission', 'maintenance', 'activity']) { x.control[key] = null; assert.equal((await x.runtime.status()).known, false); x.control[key] = true; }
});
test('actual metadata, index readers, shared host maintenance and receiver activity block writes', async t => {
    const x = await fixture(t);
    for (const mutate of [() => { x.lib.workers = 1; return () => { x.lib.workers = 0; }; }, () => { x.lib.repairIndexReaders = 1; return () => { x.lib.repairIndexReaders = 0; }; }, () => { x.lib.metadataPending.add('own'); return () => x.lib.metadataPending.clear(); }]) {
        const restore = mutate(); await assert.rejects(x.register()); assert.deepEqual(tables(x), []); restore();
    }
    const hold = defer(), entered = defer(), work = x.host.track(async () => { entered.resolve(); await hold.promise; }, { maintenance: true }); await entered.promise;
    await assert.rejects(x.register()); hold.resolve(); await work;
    x.control.downloads.active = 1; await assert.rejects(x.register(), { code: 'BUSY' }); assert.deepEqual(tables(x), []); x.control.downloads.active = 0;
    await x.register(); await x.full(); x.control.activity = null; await assert.rejects(x.runtime.start(x.startInput()), { code: 'RUNTIME_GATE_UNKNOWN' }); assert.equal(x.runtime.scheduler.started, false);
});
test('explicit current namespace plan prevents stale consent, no implicit recover/automatic start', async t => {
    const x = await fixture(t); await x.register(); await x.full(); const old = x.startInput(); await x.batch();
    await assert.rejects(x.runtime.start(old), { code: 'VERSION_CONFLICT' }); await assert.rejects(x.runtime.start({ ...x.startInput(), automatic: undefined }), { code: 'INVALID_REQUEST' });
    await assert.rejects(x.runtime.start({ ...x.startInput(), recover: true }), { code: 'INVALID_REQUEST' }); assert.equal(x.runtime.scheduler.started, false);
    const result = await x.runtime.start(x.startInput()); assert.equal(result.started, true); assert.equal(result.timers, 0); assert.equal(x.control.calls.length, 0);
});
test('real original HTTP adapter capabilities/eligibility and actual scheduler tick hold same manual gate', async t => {
    const x = await fixture(t); await x.register(); await x.full(); const batch = await x.batch();
    const item = x.runtime.batches.rows(batch.batchId)[0]; const eligible = await x.runtime.remote.eligibility(x.who, { item }); assert.equal(eligible.canCreateUploads, true);
    assert.deepEqual(x.control.calls.map(r => r.path), ['/media/upload-eligibility', '/media/upload-capabilities']); x.control.calls.length = 0;
    await x.runtime.start(x.startInput()); const hold = defer(); x.control.holdCloud = hold;
    const tick = x.runtime.scheduler.tick(); await wait(() => x.control.calls.length > 0); assert.equal(x.runtime.scheduler.dispatchState().held, true);
    await assert.rejects(x.manual.download(async () => {}), { code: 'BUSY' }); await assert.rejects(x.runtime.fullScan({ rootId: x.root.id, confirmed: true }), { code: 'HOST_BUSY' });
    hold.resolve(); x.control.holdCloud = null; await tick; assert.equal(x.runtime.scheduler.dispatchState().settled, true); await x.manual.download(async () => {});
    assert.ok(x.control.calls.some(r => r.path === '/media/upload-capabilities'));
});
test('disconnect does not release actual handler or existing host lease; timeout retains runtime owner', async t => {
    const x = await fixture(t); await x.register(); await x.full(); const hold = defer(); x.control.holdPermission = hold;
    const controller = new AbortController(); const req = fetch(x.url + x.runtime.basePath + '/scope-roots', { headers: { Cookie: 'media_session=controlled' }, signal: controller.signal }).catch(() => {});
    await wait(() => x.runtime.handle.state().active === 1); controller.abort(); await req;
    assert.equal((await x.runtime.dispose({ timeoutMs: 5 })).closed, false); assert.ok(x.host.active > 0); assert.throws(() => new CloudUploadTaskRuntime(x.options), { code: 'RUNTIME_BINDING_INVALID' }); assert.equal(x.lib.db.open, true);
    hold.resolve(); x.control.holdPermission = null; await wait(() => x.runtime.handle.state().active === 0); assert.equal((await x.runtime.dispose()).closed, true);
});
test('pending actual manual status acquisition cannot be replaced or released by dispose deadline', async t => {
    const x = await fixture(t); await x.register(); await x.full(); await x.batch(); await x.runtime.start(x.startInput());
    const hold = defer(); x.control.holdDownloadStatus = hold; const tick = x.runtime.scheduler.tick(); await wait(() => x.runtime.scheduler.dispatchState().acquiring);
    const result = await x.runtime.dispose({ timeoutMs: 5 }); assert.equal(result.closed, false); await assert.rejects(x.manual.download(async () => {}), { code: 'BUSY' }); assert.equal(x.lib.db.open, true);
    hold.resolve(); x.control.holdDownloadStatus = null; await assert.rejects(tick, { code: 'AUTH_CHANGED' }); assert.equal((await x.runtime.dispose()).closed, true); assert.equal(x.control.calls.length, 0); await x.manual.download(async () => {});
});
test('full identity change during awaited handler poisons generation and cannot reuse old runtime', async t => {
    const x = await fixture(t); await x.register(); await x.full(); const hold = defer(); x.control.holdPermission = hold;
    const req = x.call('GET', '/scope-roots'); await wait(() => x.runtime.handle.state().active > 0); x.who = { ...x.who, epoch: 2 }; hold.resolve(); x.control.holdPermission = null;
    assert.notEqual((await req).status, 200); assert.equal(x.runtime.poisoned, true); assert.equal((await x.runtime.status()).known, false); assert.equal(x.control.calls.length, 0);
});
test('reopened proof needs explicit new session/full and historical batches need per-batch resume', async t => {
    const x = await fixture(t); await x.register(); await x.full(); const old = await x.batch(); const version = x.runtime.proof.status().version;
    assert.equal((await x.runtime.dispose()).closed, true); x.who = { ...x.who, epoch: 2 };
    const runtime = new CloudUploadTaskRuntime(x.options); x.runtime = runtime;
    // Existing private HTTP app retains the closed first runtime. This test uses
    // actual domain lifecycle methods on the explicitly new generation only.
    assert.equal(runtime.proof.status().known, false);
    await runtime.admitProof({ mode: 'OPEN_SESSION', clientCommandId: randomUUID(), expectedVersion: version });
    const request = { rootVector: [{ rootId: x.root.id, revision: x.lib.rootById(x.root.id).revision, reconciledMs: x.lib.rootById(x.root.id).reconciled_ms }], scopes: [{ rootId: x.root.id }] };
    assert.equal(runtime.proof.readCompletion(request).complete, false);
    const input = () => ({ scope: CLOUD_UPLOAD_RUNTIME_SCOPE, queueFingerprint: runtime.queuePlan().queueFingerprint, confirmed: true, automatic: false, recover: false });
    await assert.rejects(runtime.start(input()), { code: 'HISTORICAL_QUEUE_REQUIRES_COMMAND' });
    const recovered = await runtime.recover({ scope: CLOUD_UPLOAD_RUNTIME_SCOPE, queueFingerprint: runtime.queuePlan().queueFingerprint, confirmed: true }); assert.equal(recovered.dispatchStarted, false);
    const saved = runtime.batches.owned(x.who, old.batchId); assert.equal(saved.state, 'PAUSED'); assert.equal(saved.epoch, 1);
    await runtime.command(old.batchId, { clientCommandId: randomUUID(), expectedVersion: saved.version, action: 'resume' }); assert.equal(runtime.batches.owned(x.who, old.batchId).epoch, 2);
    await runtime.fullScan({ rootId: x.root.id, confirmed: true }); assert.equal((await runtime.start(input())).started, true);
});

test('registration refuses late identity change at actual host before-schema await before DDL', async t => {
    const x = await fixture(t);
    x.host.hook = async point => { if (point === 'before-schema') x.who = { ...x.who, epoch: 2 }; };
    await assert.rejects(x.runtime.registerHost({ clientCommandId: randomUUID(), expectedVersion: 0,
        assetIds: x.lib.db.prepare('SELECT id FROM assets').all().map(r => r.id) }));
    assert.equal(tables(x).length, 0, 'late old-host callback must not create the eight business tables');
});

test('actual root ABA invalidates proof and prevents explicit scheduler start until new real full', async t => {
    const x = await fixture(t); await x.register(); await x.full(); await x.batch();
    const name = x.lib.rootById(x.root.id).name;
    x.lib.db.prepare("UPDATE roots SET name='own-temporary' WHERE id=?").run(x.root.id); x.lib.db.prepare('UPDATE roots SET name=? WHERE id=?').run(name, x.root.id);
    await assert.rejects(x.runtime.start(x.startInput()), { code: 'SCAN_PROOF_UNKNOWN' }); assert.equal(x.runtime.scheduler.started, false); assert.equal(x.control.calls.length, 0);
    await x.full(); assert.equal((await x.runtime.start(x.startInput())).started, true);
});

test('actual preview inspection file close must settle before handler/host/runtime release', async t => {
    const x = await fixture(t); await x.register(); await x.full();
    const category = await x.call('GET', '/scope-categories?rootIds=' + x.root.id);
    const payload = { clientCommandId: randomUUID(), scopes: [{ rootId: x.root.id, category: null, subcategory: null }], target: { visibility: 'PRIVATE', groupId: null }, categoryOverride: null };
    const ticket = await x.call('POST', '/scope-bindings', { ...payload, scopeSchema: 'scope-null-v1', providerBinding: category.body.data.binding }); assert.equal(ticket.status, 200);
    const file = path.join(x.dir, 'own-media', 'A', 'B', 'own.wav'), original = fs.open, closeEntered = defer(), release = defer(); let handle;
    fs.open = async (name, ...args) => { const h = await original(name, ...args); if (String(name) === file) { handle = h; const realClose = h.close.bind(h); h.close = async () => { closeEntered.resolve(); await release.promise; await realClose(); }; } return h; };
    const request = x.call('POST', '/previews', { ...payload, scopeBinding: ticket.body.data.scopeBinding });
    try {
        await closeEntered.promise; assert.ok(handle.fd >= 0); assert.equal(x.upload.inspections.size, 1);
        assert.equal((await x.runtime.dispose({ timeoutMs: 5 })).closed, false); assert.equal(x.lib.db.open, true); assert.ok(x.host.active > 0); assert.ok(handle.fd >= 0);
    } finally { release.resolve(); fs.open = original; }
    assert.notEqual((await request).status, 200); await wait(() => x.runtime.handle.state().active === 0);
    assert.equal(handle.fd, -1); assert.equal(x.upload.inspections.size, 0); assert.equal((await x.runtime.dispose()).closed, true);
    assert.equal(x.lib.db.prepare('SELECT COUNT(*) n FROM cloud_upload_previews').get().n, 0);
});

test('observed actual DB handle change poisons old generation even when original pointer is restored', async t => {
    const x = await fixture(t); await x.register(); await x.full(); const original = x.lib.db, other = new Database(original.name);
    try { x.lib.db = other; assert.equal((await x.runtime.status()).known, false); }
    finally { x.lib.db = original; other.close(); }
    assert.equal(x.runtime.poisoned, true); assert.equal((await x.runtime.status()).known, false); assert.equal(x.lib.db.open, true);
});

test('host trusted synchronous proof is mandatory and async/false/undefined cannot authorize runtime registration', async t => {
    for (const assertion of [undefined, async () => true, () => false, () => undefined]) {
        const x = await fixture(t); x.runtime.assertHostRegistrationCurrent = assertion;
        await assert.rejects(x.register(), { code: 'RUNTIME_GATE_UNKNOWN' }); assert.deepEqual(tables(x), []); assert.equal(x.host.registration, null);
    }
});
test('actual host before-schema permission revocation keeps INIT_PENDING audit and zero business DDL', async t => {
    const x = await fixture(t); x.host.hook = async stage => { if (stage === 'before-schema') x.control.permission = false; };
    const result = await x.runtime.registerHost({ clientCommandId: randomUUID(), expectedVersion: 0,
        assetIds: x.lib.db.prepare('SELECT id FROM assets').all().map(r => r.id) });
    assert.equal(result.ready, false); assert.equal(result.phase, 'INIT_PENDING'); assert.equal(result.code, 'RUNTIME_GATE_UNKNOWN'); assert.deepEqual(tables(x), []); assert.equal(x.host.registration.phase, 'INIT_PENDING');
});
test('actual runtime closing at original host await prevents DDL and retains owner until work settles', async t => {
    const x = await fixture(t); let disposing;
    x.host.hook = async stage => { if (stage === 'before-schema') disposing = x.runtime.dispose({ timeoutMs: 0 }); };
    await assert.rejects(x.runtime.registerHost({ clientCommandId: randomUUID(), expectedVersion: 0,
        assetIds: x.lib.db.prepare('SELECT id FROM assets').all().map(r => r.id) }), { code: 'RUNTIME_CLOSED' });
    assert.equal((await disposing).closed, false); assert.deepEqual(tables(x), []); assert.equal(x.host.registration.phase, 'INIT_PENDING'); assert.equal(x.lib.db.open, true);
    assert.equal((await x.runtime.dispose()).closed, true);
});

test('attachment restoration cannot revive poisoned generation or mutate a batch', async t => {
    for (const [target, property] of [['upload', 'auth'], ['upload', 'lib'], ['host', 'upload']]) {
        const x = await fixture(t); await x.register(); await x.full(); const batch = await x.batch(), object = x[target], prior = object[property];
        const before = x.lib.db.prepare('SELECT state,version FROM cloud_upload_batches WHERE batch_id=?').get(batch.batchId);
        try {
            object[property] = {};
            // First operation is a real write command, without a status call
            // that could independently poison the generation beforehand.
            await assert.rejects(x.runtime.command(batch.batchId, { clientCommandId: randomUUID(), expectedVersion: batch.version, action: 'pause' }), { code: 'STORE_BINDING_CHANGED' });
            assert.equal((await x.runtime.status()).known, false); assert.equal(x.runtime.poisoned, true);
        }
        finally { object[property] = prior; }
        assert.equal((await x.runtime.status()).known, false);
        await assert.rejects(x.runtime.command(batch.batchId, { clientCommandId: randomUUID(), expectedVersion: batch.version, action: 'pause' }), { code: 'RUNTIME_CLOSED' });
        assert.deepEqual(x.lib.db.prepare('SELECT state,version FROM cloud_upload_batches WHERE batch_id=?').get(batch.batchId), before);
    }
});
test('attachment changes during awaited command stay poisoned after pointer restoration before continuation', async t => {
    for (const [target, property] of [['upload', 'auth'], ['upload', 'lib'], ['host', 'upload']]) {
        const x = await fixture(t); await x.register(); await x.full(); const batch = await x.batch(), object = x[target], prior = object[property], hold = defer(), entered = defer();
        x.runtime.readPermission = async () => { entered.resolve(); await hold.promise; return { known: true, allowed: true }; };
        const command = x.runtime.command(batch.batchId, { clientCommandId: randomUUID(), expectedVersion: batch.version, action: 'pause' });
        const rejected = assert.rejects(command, { code: 'RUNTIME_CLOSED' }); await entered.promise;
        try { object[property] = {}; assert.equal((await x.runtime.status()).known, false); assert.equal(x.runtime.poisoned, true); }
        finally { object[property] = prior; hold.resolve(); }
        await rejected; assert.equal((await x.runtime.status()).known, false);
        const saved = x.lib.db.prepare('SELECT state,version FROM cloud_upload_batches WHERE batch_id=?').get(batch.batchId); assert.deepEqual(saved, { state: batch.state, version: batch.version });
    }
});

test('attachment poison during actual pending HTTP keeps original lease and DB until true settlement', async t => {
    const x = await fixture(t); await x.register(); await x.full(); await x.batch(); await x.runtime.start(x.startInput());
    const hold = defer(); x.control.holdCloud = hold; const tick = x.runtime.scheduler.tick().catch(e => ({ error: e.code })); await wait(() => x.control.calls.length > 0);
    const auth = x.upload.auth; x.upload.auth = {};
    try { assert.equal((await x.runtime.status()).known, false); assert.equal(x.runtime.poisoned, true); }
    finally { x.upload.auth = auth; }
    assert.equal((await x.runtime.dispose({ timeoutMs: 5 })).closed, false); assert.equal(x.lib.db.open, true); assert.equal(x.runtime.scheduler.dispatchState().held, true);
    await assert.rejects(x.manual.download(async () => {}), { code: 'BUSY' }); assert.throws(() => new CloudUploadTaskRuntime(x.options), { code: 'RUNTIME_BINDING_INVALID' });
    hold.resolve(); x.control.holdCloud = null; await tick;
    assert.equal((await x.runtime.dispose()).closed, true); assert.equal(x.lib.db.open, true); await x.manual.download(async () => {});
});

if (process.env.UQ04B6_UNKNOWN_CHILD === '1') test('unknown retained owner child', async t => {
    const x = await fixture(t, { retainOwner: true }); await x.register(); await x.full(); await x.batch(); await x.runtime.start(x.startInput());
    const hold = defer(); x.control.holdCloud = hold; const tick = x.runtime.scheduler.tick(); await wait(() => x.control.calls.length > 0);
    x.control.activity = null; hold.resolve(); x.control.holdCloud = null; await tick;
    assert.equal(x.runtime.scheduler.dispatchState().unknown, true);
    const result = await x.runtime.dispose({ timeoutMs: 5 }); assert.equal(result.closed, false); assert.equal(result.unknown, true);
    await assert.rejects(x.manual.download(async () => {}), { code: 'BUSY' }); assert.equal(x.lib.db.open, true); assert.equal(x.host.closed, false); assert.equal(x.upload.disposing, false);
    assert.throws(() => new CloudUploadTaskRuntime(x.options), { code: 'RUNTIME_BINDING_INVALID' });
    await x.closeServersOnly();
    console.log('UQ04B6_UNKNOWN_OWNER=' + JSON.stringify({ dir: x.dir, runtime: result, dispatch: x.runtime.scheduler.dispatchState(), dbOpen: x.lib.db.open, policy: 'RETAIN_ALL; natural child exit; no DB/upload/auth/host close; not OS SIGKILL' }));
    const y = await fixture(t, { retainOwner: true }); await y.register(); await y.full();
    const cas = defer(), entered = defer(); y.runtime.proof.hook = async point => { if (point === 'before-cas') { entered.resolve(); await cas.promise; } };
    const scan = y.runtime.fullScan({ rootId: y.root.id, confirmed: true }); const rejected = assert.rejects(scan, { code: 'SCAN_PROOF_UNKNOWN' });
    await entered.promise; y.who = { ...y.who, epoch: 2 }; cas.resolve(); await rejected;
    assert.equal(y.runtime.proof.active.size, 1); const ledger = y.lib.db.prepare('SELECT state,lease_id FROM cloud_upload_scan_proofs WHERE root_id=?').get(y.root.id); assert.equal(ledger.state, 'RUNNING'); assert.ok(ledger.lease_id);
    const exit = await y.runtime.dispose({ timeoutMs: 5 }); assert.equal(exit.closed, false); assert.equal(y.lib.db.open, true); assert.equal(y.host.closed, false); await y.closeServersOnly();
    console.log('UQ04B6_UNKNOWN_PROOF=' + JSON.stringify({ dir: y.dir, runtime: exit, ledgerState: ledger.state, leaseRetained: true, dbOpen: y.lib.db.open, after: 'RETAIN_ALL; natural exit; no forced lease clear/shared close' }));
});
else test('unknown dispatch keeps actual shared manual lease/DB/generation in isolated child', () => {
    const childEnv = { ...process.env, UQ04B6_UNKNOWN_CHILD: '1' }; delete childEnv.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, ['--test', '--test-name-pattern=unknown retained owner child', fileURLToPath(import.meta.url)], {
        env: childEnv, encoding: 'utf8', timeout: 15000 });
    process.stdout.write(child.stdout); process.stderr.write(child.stderr);
    assert.equal(child.status, 0); assert.match(child.stdout, /UQ04B6_UNKNOWN_OWNER=.*"dbOpen":true/); assert.match(child.stdout, /UQ04B6_UNKNOWN_PROOF=.*"leaseRetained":true/);
});
