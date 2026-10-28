// Composition only. Inject the application's existing host/auth/upload/manual admission.
// Construction does not inspect disk/SQL, register, scan, recover or start a timer.
import { CloudUploadBatchStore } from './cloud-upload-batch-store.mjs';
import { CloudUploadScanProof } from './cloud-upload-scan-proof.mjs';
import { createCloudUploadScopeProvider } from './cloud-upload-scope-provider.mjs';
import { CloudUploadScopeBinding } from './cloud-upload-scope-binding.mjs';
import { CloudUploadPreview } from './cloud-upload-preview.mjs';
import { CloudUploadBatches } from './cloud-upload-batches.mjs';
import { CloudUploadScheduler } from './cloud-upload-scheduler.mjs';
import { CloudUploadHttpAdapter } from './cloud-upload-http-adapter.mjs';
import { createCloudUploadTaskRouter } from './cloud-upload-task-router.mjs';
import { reconcileRoot } from './reconcile.mjs';
import { identity, sameIdentity, fingerprint, namespace, exact, id, integer, fail } from './cloud-upload-protocol.mjs';

const owners = new WeakMap(), diskOwners = new Map();
const initial = new WeakMap();
const sleep = () => new Promise(resolve => setTimeout(resolve, 2));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const terminal = new Set(['COMPLETED', 'COMPLETED_WITH_ISSUES', 'STOPPED']);
export const CLOUD_UPLOAD_RUNTIME_SCOPE = 'CURRENT_NAMESPACE_ALL_PENDING';

// One immediate attempt, no queue/timer. The same HOST lease covers the passive
// decision and all actual MissingFiles writes; the existing manual gate also
// excludes downloads. Never construct an owner or ask a remote permission here.
export async function runFileStatusMaintenance({ lib, upload, host, manualAudioAdmission, readRuntime }, work) {
    const deferred = code => ({ deferred: true, code });
    const busyCodes = new Set(['HOST_BUSY', 'BUSY', 'FILE_MAINTENANCE_BUSY', 'FILE_MAINTENANCE_UNKNOWN']);
    let invoked = false;
    try {
        return await host.track(() => manualAudioAdmission.upload(async () => {
            if (host.lib !== lib || host.db !== lib.db || host.upload !== upload || upload.lib !== lib ||
                host.closed || host.loadCode || host.exclusive !== true || host.active !== 1 ||
                typeof readRuntime !== 'function' || typeof work !== 'function') fail('FILE_MAINTENANCE_UNKNOWN', 423);
            if (!(upload.operations instanceof Set) || !(upload.controllers instanceof Map) ||
                !(upload.inspections instanceof Map) || !(upload.settledTasks instanceof Set) || !Array.isArray(upload.jobs) ||
                upload.jobs.length > 50 || upload.repairInitialized !== true || typeof upload.busy !== 'boolean' || typeof upload.disposing !== 'boolean' || upload.disposing) fail('FILE_MAINTENANCE_UNKNOWN', 423);
            if (upload.busy || upload.operations.size || upload.controllers.size || upload.inspections.size ||
                upload.settledTasks.size || upload.jobs.some(j => !j || j.batchBinding || !['completed', 'cancelled', 'failed'].includes(j.state))) fail('FILE_MAINTENANCE_BUSY', 423);
            // Read after admission's await: a runtime may have been constructed
            // while the shared gate was acquiring its real download snapshot.
            const runtime = readRuntime();
            if (runtime === null) {
                // A registered historical queue without its attached owner is
                // unknown, never an invitation to construct/recover one here.
                if (host.registration !== null || lib.scanProof) fail('FILE_MAINTENANCE_UNKNOWN', 423);
            } else {
                const state = CloudUploadTaskRuntime.prototype.fileMaintenanceState.call(runtime, { lib, upload, host, manualAudioAdmission });
                if (!state.known) fail('FILE_MAINTENANCE_UNKNOWN', 423);
                if (!state.idle) fail('FILE_MAINTENANCE_BUSY', 423);
            }
            invoked = true; return work();
        }), { maintenance: true });
    } catch (error) {
        if (!invoked && busyCodes.has(error?.code)) return deferred(error.code);
        throw error;
    }
}

export class CloudUploadTaskRuntime {
    constructor({ lib, upload, cloudAuth, host, manualAudioAdmission, currentIdentity,
        guardLocalRequest, readPermission, readMaintenance, readActivity, assertHostRegistrationCurrent } = {}) {
        if (!lib?.db || upload?.lib !== lib || upload?.auth !== cloudAuth || host?.lib !== lib || host?.db !== lib.db || host?.upload !== upload ||
            typeof host.track !== 'function' || typeof host.descriptor !== 'function' ||
            !manualAudioAdmission || ['upload', 'download'].some(k => typeof manualAudioAdmission[k] !== 'function') ||
            typeof currentIdentity !== 'function' || ['getState', 'proxy', 'uploadAudioContent'].some(k => typeof cloudAuth?.[k] !== 'function') ||
            lib.scanProof || owners.has(lib.db) || owners.has(upload)) fail('RUNTIME_BINDING_INVALID', 503);
        this.lib = lib; this.db = lib.db; this.upload = upload; this.auth = cloudAuth; this.host = host;
        this.manualAudioAdmission = manualAudioAdmission; this.currentIdentity = currentIdentity;
        this.guardLocalRequest = guardLocalRequest; this.readPermission = readPermission;
        this.readMaintenance = readMaintenance; this.readActivity = readActivity;
        this.assertHostRegistrationCurrent = assertHostRegistrationCurrent;
        this.closing = false; this.closed = false; this.poisoned = false; this.captured = null; this.descriptorValue = null;
        this.diskKey = null; this.operations = new Set(); this.hostLeases = new Set(); this.permits = new Set();
        owners.set(this.db, this); owners.set(upload, this);
        const capability = { sourceId: host.sourceId,
            descriptor: () => { this.who(); return this.binding(); },
            identity: () => { this.who(); const d = this.binding(); return { dev: d.dev, ino: d.ino }; },
            authorize: async ({ database }) => { await this.gates({ maintenanceOwner: true }); return database === this.db; } };
        this.proof = new CloudUploadScanProof(lib, { capability });
        this.store = new CloudUploadBatchStore(this.db);
        const who = () => this.who();
        this.provider = createCloudUploadScopeProvider(lib, { readCompletion: request => this.proof.readCompletion(request) });
        this.bindings = new CloudUploadScopeBinding({ lib, upload, provider: this.provider, proof: this.proof, currentIdentity: who });
        this.preview = new CloudUploadPreview(this.store, { currentIdentity: who, scopeBindings: this.bindings,
            snapshotScope: async () => fail('SCOPE_NOT_READY') });
        this.remote = new CloudUploadHttpAdapter({ auth: cloudAuth, upload, currentIdentity: who });
        this.batches = new CloudUploadBatches(this.store, this.preview, { upload, currentIdentity: who,
            authorize: async (w, item) => this.remote.eligibility(w, { item }) });
        this.scheduler = new CloudUploadScheduler(this.batches, { remote: this.remote, dispatchPermit: {
            enter: (w, options) => this.enterDispatch(w, options),
            check: async (w, permit) => {
                if (!this.permits.has(permit)) return { unknown: true };
                try { await this.gates(); this.assertWho(w); this.requireQueueProof(); return { allowed: true }; }
                catch (error) { if (['RUNTIME_GATE_UNKNOWN', 'ACTIVITY_UNKNOWN', 'UPLOAD_STATE_UNKNOWN', 'SCAN_PROOF_UNKNOWN'].includes(error?.code)) return { unknown: true }; throw error; }
            },
            leave: async (_w, permit) => {
                if (!this.permits.has(permit)) return { unknown: true };
                permit.release.resolve(); await permit.work; this.permits.delete(permit);
                return { released: true, settled: true };
            }
        } });
        this.handle = createCloudUploadTaskRouter({ preview: this.preview, batches: this.batches, scheduler: this.scheduler,
            retryRemote: this.remote, scopeBindings: this.bindings, currentIdentity: who,
            guardLocalRequest: async (req, context) => { this.who(); if (typeof this.guardLocalRequest !== 'function') fail('LOCAL_SESSION_REQUIRED', 401); const result = await this.guardLocalRequest(req, context); this.who(); return result; },
            authorize: async (w, context) => { this.assertWho(w); await this.gates({ context }); return { allowed: true }; },
            assertMaintenance: async () => { await this.gates(); const ready = await host.readiness(); this.who(); if (!ready.ready) fail('RUNTIME_NOT_READY', 503); return { allowed: true }; }
        });
        this.basePath = this.handle.basePath;
        // Express 4 discards the return value of its inner layer. The original
        // router's active count tracks actual promises, including disconnected
        // requests. Keep the existing host.track lease until that count is zero.
        this.router = (req, res, next) => {
            if (this.closing || this.poisoned) { res.status(503).json({ error: { code: 'RUNTIME_CLOSED' } }); return; }
            this.trackHost(async () => {
                this.handle.router(req, res, next);
                while (this.handle.state().active) await sleep();
            }).catch(() => { if (!res.destroyed && !res.headersSent) res.status(423).json({ error: { code: 'HOST_BUSY' } }); });
        };
        initial.set(this, Object.freeze({ lib, db: lib.db, upload, auth: cloudAuth, host,
            manualAudioAdmission, currentIdentity, proof: this.proof, handle: this.handle, scheduler: this.scheduler, store: this.store, sourceId: host.sourceId }));
    }
    fileMaintenanceState({ lib, upload, host, manualAudioAdmission }) {
        // Passive and synchronous under the caller's exclusive HOST lease. No
        // who()/gates()/readiness()/schema(), SQL init, capture or new ownership.
        try {
            const s = initial.get(this), unknown = () => ({ known: false, idle: false });
            if (!s || this.closing || this.closed || this.poisoned || s.lib !== lib || s.upload !== upload || s.host !== host ||
                s.manualAudioAdmission !== manualAudioAdmission || this.lib !== lib || this.db !== s.db || lib.db !== s.db ||
                this.upload !== upload || this.auth !== s.auth || upload.auth !== s.auth || this.host !== host || host.db !== s.db ||
                this.manualAudioAdmission !== manualAudioAdmission || this.currentIdentity !== s.currentIdentity ||
                this.proof !== s.proof || this.scheduler !== s.scheduler || this.handle !== s.handle || this.store !== s.store ||
                this.store.db !== s.db || owners.get(s.db) !== this || owners.get(upload) !== this ||
                host.sourceId !== s.sourceId || host.exclusive !== true || host.active !== 1 || host.closed || host.loadCode) return unknown();
            const w = identity(s.currentIdentity()), auth = s.auth.getState();
            if (auth.state !== 'logged-in' || auth.accountId !== w.accountId || auth.deviceId !== w.deviceId ||
                s.auth.epoch !== w.epoch || w.librarySourceId !== s.sourceId || this.captured && !sameIdentity(this.captured, w)) return unknown();
            const descriptor = { ...host.descriptor(), sourceId: s.sourceId };
            if (this.descriptorValue && (fingerprint(descriptor) !== fingerprint(this.descriptorValue) || diskOwners.get(this.diskKey) !== this)) return unknown();
            if (!(this.operations instanceof Set) || !(this.hostLeases instanceof Set) || !(this.permits instanceof Set) ||
                !(s.proof.active instanceof Map) || typeof s.proof.pending !== 'boolean' || s.proof.closed) return unknown();
            const dispatch = s.scheduler.dispatchState();
            if (dispatch.unknown || typeof dispatch.settled !== 'boolean') return unknown();
            if (this.operations.size || this.hostLeases.size || this.permits.size || s.proof.active.size || s.proof.pending || s.handle.state().active ||
                s.scheduler.inflight || !dispatch.settled) return { known: true, idle: false };
            // A settled scheduler closing on an unknown failure is not an idle
            // owner. A normal, explicitly disposed owner is detached by index.
            if (s.scheduler.closing || s.scheduler.closed) return unknown();
            if (host.registration === null) return s.proof.epoch !== null || lib.scanProof !== s.proof ? unknown() : { known: true, idle: true };
            if (host.registration?.phase !== 'READY' || host.registration.sourceId !== s.sourceId ||
                fingerprint(host.registration.dbIdentity) !== fingerprint(host.descriptor()) || s.db.kind === 'mysql' || s.db.inTransaction ||
                lib.scanProof !== s.proof || s.proof.lib !== lib || s.proof.db !== s.db || s.proof.capability.sourceId !== s.sourceId) return unknown();
            // Bounded result, no history materialized. Terminal batch projection
            // precedes cleanup, so inspect unresolved item flags as well. Invalid
            // JSON fails closed; do not trust COMPLETED alone as settlement.
            const args = [w.cloudServiceKey, w.accountId, w.deviceId, w.librarySourceId];
            const scope = 'b.cloud_service_key=? AND b.account_id=? AND b.device_id=? AND b.library_source_id=?';
            const invalid = s.db.prepare(`SELECT 1 FROM cloud_upload_batches b WHERE ${scope} AND CASE WHEN LENGTH(b.record_json)>65536 THEN 1 WHEN json_valid(b.record_json) THEN
                json_type(b.record_json)<>'object' OR json_extract(b.record_json,'$.batchId') IS NOT b.batch_id OR json_extract(b.record_json,'$.state') IS NOT b.state
                ELSE 1 END LIMIT 1`).get(...args);
            if (invalid) return unknown();
            const active = s.db.prepare(`SELECT 1 FROM cloud_upload_batches b WHERE ${scope} AND b.state NOT IN ('COMPLETED','COMPLETED_WITH_ISSUES','STOPPED') LIMIT 1`).get(...args);
            const unsettled = s.db.prepare(`SELECT 1 FROM cloud_upload_batch_items i JOIN cloud_upload_batches b ON b.batch_id=i.batch_id WHERE ${scope} AND
                (i.state NOT IN ('COMMITTED','SKIPPED','FAILED','CANCELLED') OR CASE WHEN LENGTH(i.record_json)>65536 THEN 1 WHEN json_valid(i.record_json) THEN
                json_type(i.record_json)<>'object' OR json_extract(i.record_json,'$.itemId') IS NOT i.item_id OR json_extract(i.record_json,'$.state') IS NOT i.state OR
                COALESCE(json_extract(i.record_json,'$.cleanupPending'),0)<>0 OR COALESCE(json_extract(i.record_json,'$.resourcesRetained'),0)<>0
                ELSE 1 END) LIMIT 1`).get(...args);
            return { known: true, idle: !active && !unsettled };
        } catch { return { known: false, idle: false }; }
    }
    who() {
        if (this.closing || this.poisoned) fail('RUNTIME_CLOSED', 503);
        this.binding();
        let w;
        try { w = identity(this.currentIdentity()); const s = this.auth.getState();
            if (s.state !== 'logged-in' || s.accountId !== w.accountId || s.deviceId !== w.deviceId || this.auth.epoch !== w.epoch || this.host.sourceId !== w.librarySourceId) fail('AUTH_CHANGED');
            if (this.captured && !sameIdentity(this.captured, w)) fail('AUTH_CHANGED');
        } catch (e) { if (this.captured) { this.poisoned = true; this.handle?.dispose(); } throw e; }
        if (!this.captured) this.captured = w;
        this.binding(); return w;
    }
    assertWho(w) { if (!sameIdentity(w, this.who())) fail('AUTH_CHANGED'); }
    binding() {
        if (this.poisoned || this.closing) fail('STORE_BINDING_CHANGED');
        const s = initial.get(this);
        if (!s || this.lib !== s.lib || this.db !== s.db || this.upload !== s.upload || this.auth !== s.auth || this.host !== s.host ||
            this.manualAudioAdmission !== s.manualAudioAdmission || this.currentIdentity !== s.currentIdentity ||
            s.lib.db !== s.db || s.upload.lib !== s.lib || s.upload.auth !== s.auth || s.host.lib !== s.lib || s.host.db !== s.db || s.host.upload !== s.upload ||
            this.proof !== s.proof || s.lib.scanProof !== s.proof || s.proof.lib !== s.lib || s.proof.db !== s.db ||
            s.host.sourceId !== s.sourceId || s.proof.capability.sourceId !== s.sourceId ||
            owners.get(s.db) !== this || owners.get(s.upload) !== this || this.diskKey && diskOwners.get(this.diskKey) !== this) {
            this.poisoned = true; this.handle?.dispose(); fail('STORE_BINDING_CHANGED');
        }
        // Complete trusted path/nlink/birth-time checks precede dev/ino projection.
        let d;
        try { d = { ...this.host.descriptor(), sourceId: this.host.sourceId }; }
        catch (error) { if (this.descriptorValue) { this.poisoned = true; this.handle?.dispose(); } throw error; }
        const key = fingerprint({ engine: d.engine, dev: d.dev, ino: d.ino, birthtimeMs: d.birthtimeMs });
        if (this.descriptorValue && fingerprint(this.descriptorValue) !== fingerprint(d) || diskOwners.has(key) && diskOwners.get(key) !== this) {
            this.poisoned = true; this.handle?.dispose(); fail('STORE_BINDING_CHANGED');
        }
        if (!this.descriptorValue) { this.descriptorValue = d; this.diskKey = key; diskOwners.set(key, this); }
        return { ...d };
    }
    activity({ maintenanceOwner = false } = {}) {
        const l = this.lib;
        if (!(l.jobs instanceof Map) || !(l.locks instanceof Set) || !(l.metadataPending instanceof Set) || !Array.isArray(l.metadataQueue) ||
            !Number.isSafeInteger(l.workers) || !Number.isSafeInteger(l.repairIndexReaders) || l.repairIndexReaders < 0 ||
            !this.upload.repairInitialized || this.upload.disposing || !(this.upload.operations instanceof Set) || !(this.upload.inspections instanceof Map)) fail('ACTIVITY_UNKNOWN', 503);
        if (l.workers || l.metadataPending.size || l.metadataQueue.length || l.repairIndexReaders || l.locks.size ||
            [...l.jobs.values()].some(j => !['done', 'failed', 'partial', 'cancelled', 'interrupted'].includes(j?.status)) ||
            this.host.closed || this.host.exclusive !== maintenanceOwner || this.host.active !== this.hostLeases.size) fail('MAINTENANCE_BUSY', 423);
        // A scheduler lease may own upload operations; every other upload operation
        // must settle before registration/full scan/new dispatch acquisition.
        if (!this.permits.size && (this.upload.busy || this.upload.controllers.size || this.upload.operations.size || this.upload.settledTasks.size || this.upload.inspections.size)) fail('UPLOAD_STATE_UNKNOWN', 503);
    }
    async gates({ maintenanceOwner = false, context = null } = {}) {
        const w = this.who(); this.activity({ maintenanceOwner });
        for (const [read, denied] of [[this.readPermission, 'FORBIDDEN'], [this.readMaintenance, 'MAINTENANCE_BUSY'], [this.readActivity, 'MAINTENANCE_BUSY']]) {
            if (typeof read !== 'function') fail('RUNTIME_GATE_UNKNOWN', 503);
            const verdict = await read({ identity: { ...w }, context });
            this.assertWho(w); this.activity({ maintenanceOwner });
            if (verdict?.known !== true || typeof verdict.allowed !== 'boolean') fail('RUNTIME_GATE_UNKNOWN', 503);
            if (!verdict.allowed) fail(denied, denied === 'FORBIDDEN' ? 403 : 423);
        }
        return w;
    }
    requireRegistered() {
        const d = this.binding(), { sourceId, ...hostDescriptor } = d, h = this.host;
        if (h.loadCode || h.registration?.phase !== 'READY' || h.registration.sourceId !== sourceId ||
            fingerprint(h.registration.dbIdentity) !== fingerprint(hostDescriptor) || h.schema().state !== 'VALID') fail('RUNTIME_NOT_READY', 503);
    }
    async trackHost(work, { maintenance = false } = {}) {
        if (this.closing || this.poisoned) fail('RUNTIME_CLOSED', 503);
        this.binding();
        const token = {}; this.hostLeases.add(token);
        const result = initial.get(this).host.track(work, { maintenance });
        return Promise.resolve(result).finally(() => this.hostLeases.delete(token));
    }
    own(work) {
        const actual = Promise.resolve().then(work); this.operations.add(actual);
        actual.then(() => this.operations.delete(actual), () => this.operations.delete(actual)); return actual;
    }
    async enterDispatch(w, { signal } = {}) {
        // The existing manual gate owns download/upload exclusion. No new gate.
        const ready = deferred(), release = deferred(), permit = { release, work: null };
        permit.work = this.trackHost(() => this.manualAudioAdmission.upload(async () => {
            try { await this.gates(); this.assertWho(w); this.requireQueueProof(); if (signal?.aborted) fail('OPERATION_ABORTED');
                this.permits.add(permit); ready.resolve({ allowed: true, permit }); await release.promise;
            } catch { ready.resolve(null); }
        }));
        permit.work.then(() => ready.resolve(null), () => ready.resolve(null));
        const result = await ready.promise;
        if (result) return result;
        await permit.work.catch(() => {}); return { allowed: false, permit: null };
    }
    async status() {
        try { const w = await this.gates(), host = await this.host.readiness(); this.assertWho(w);
            return { known: true, identityKey: fingerprint(w), host, proof: this.proof.status(), scheduler: this.scheduler.state(),
                ready: false, dispatchStarted: this.scheduler.started, requiresExplicitScopeProof: true };
        } catch { return { known: false, ready: false, code: 'RUNTIME_UNKNOWN', dispatchStarted: this.scheduler.started }; }
    }
    registerHost(input) {
        return this.own(async () => { await this.gates(); const w = this.who();
            const descriptor = fingerprint(this.binding()), host = this.host, upload = this.upload, auth = this.auth;
            // Async snapshots cannot be reread synchronously inside SQLite's
            // transaction. Require the same trusted host's current permission /
            // migration / receiver proof as a synchronous assertion. No default.
            const assertCurrent = () => {
                this.assertWho(w);
                if (this.host !== host || this.upload !== upload || this.auth !== auth || upload.auth !== auth || upload.lib !== this.lib ||
                    host.lib !== this.lib || host.upload !== upload || owners.get(this.db) !== this || owners.get(upload) !== this ||
                    fingerprint(this.binding()) !== descriptor || diskOwners.get(this.diskKey) !== this) fail('STORE_BINDING_CHANGED');
                if (typeof this.assertHostRegistrationCurrent !== 'function') fail('RUNTIME_GATE_UNKNOWN', 503);
                const result = this.assertHostRegistrationCurrent({ identity: { ...w } });
                if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); fail('RUNTIME_GATE_UNKNOWN', 503); }
                if (result !== true) fail('RUNTIME_GATE_UNKNOWN', 503);
                this.assertWho(w); return true;
            };
            const result = await this.manualAudioAdmission.upload(async () => {
                await this.gates(); assertCurrent(); return host.register(input, { assertCurrent });
            }); this.assertWho(w); return result;
        });
    }
    admitProof({ mode, clientCommandId, expectedVersion } = {}) {
        if (!['REGISTER', 'OPEN_SESSION'].includes(mode)) fail('INVALID_REQUEST', 400);
        id(clientCommandId); integer(expectedVersion);
        return this.own(() => this.trackHost(() => this.manualAudioAdmission.upload(async () => {
            await this.gates({ maintenanceOwner: true }); this.requireRegistered();
            const fn = mode === 'REGISTER' ? 'register' : 'openSession';
            const result = await this.proof[fn]({ clientCommandId, expectedVersion }); this.who(); return result;
        }), { maintenance: true }));
    }
    fullScan({ rootId, confirmed } = {}) {
        id(rootId); if (confirmed !== true) fail('INVALID_REQUEST', 400);
        return this.own(() => this.trackHost(() => this.manualAudioAdmission.upload(async () => {
            await this.gates({ maintenanceOwner: true }); this.requireRegistered(); if (!this.proof.status().known) fail('SCAN_PROOF_UNKNOWN');
            const w = this.who(); const result = await reconcileRoot(this.lib, this.lib.rootById(rootId), {
                tagFiles: false, hashBudgetFiles: 0, hashBudgetBytes: 0, matchHashBudgetFiles: 0 });
            this.assertWho(w); return result;
        }), { maintenance: true }));
    }
    queuePlan() {
        const w = this.who();
        return this.store.transaction(() => {
            const rows = this.store.list('cloud_upload_batches', { ...namespace(w), deviceId: w.deviceId, librarySourceId: w.librarySourceId }, { limit: 1001, order: 'batchId' });
            if (rows.length > 1000) fail('QUEUE_SCOPE_LIMIT', 413);
            const pending = rows.filter(b => !terminal.has(b.state)).map(b => ({ batchId: b.batchId, version: b.version, state: b.state, epoch: b.epoch }));
            return { scope: CLOUD_UPLOAD_RUNTIME_SCOPE, identityKey: fingerprint(w), pending, queueFingerprint: fingerprint({ w, pending }) };
        });
    }
    queueInput(input, extra) {
        exact(input, ['scope', 'queueFingerprint', 'confirmed', ...extra]);
        if (input.scope !== CLOUD_UPLOAD_RUNTIME_SCOPE || input.confirmed !== true) fail('INVALID_REQUEST', 400);
        const plan = this.queuePlan(); if (input.queueFingerprint !== plan.queueFingerprint) fail('VERSION_CONFLICT'); return plan;
    }
    requireQueueProof() {
        this.requireRegistered();
        if (!this.proof.status().known) fail('SCAN_PROOF_UNKNOWN');
        const scopes = new Map(), rootIds = new Set(), w = this.who();
        for (const pending of this.queuePlan().pending) {
            const batch = this.batches.owned(w, pending.batchId), preview = this.preview.owned(w, batch.previewId);
            for (const s of preview.scope) {
                rootIds.add(s.rootId);
                const scope = { rootId: s.rootId, ...(s.category === null ? {} : { category: s.category }), ...(s.subcategory === null ? {} : { subcategory: s.subcategory }) };
                scopes.set(fingerprint(scope), scope);
            }
        }
        if (rootIds.size > 32 || scopes.size > 32) fail('QUEUE_SCOPE_LIMIT', 413);
        if (!rootIds.size) return;
        const rootVector = [...rootIds].sort().map(rootId => {
            const r = this.lib.rootById(rootId); return { rootId, revision: r.revision, reconciledMs: r.reconciled_ms };
        });
        const certificate = this.proof.readBoundCertificate({ rootVector, scopes: [...scopes.values()] });
        if (certificate.known !== true || certificate.complete !== true) fail('SCAN_PROOF_UNKNOWN');
    }
    recover(input) {
        return this.own(() => this.trackHost(() => this.manualAudioAdmission.upload(async () => {
            await this.gates({ maintenanceOwner: true }); this.requireRegistered(); if (!this.proof.status().known) fail('SCAN_PROOF_UNKNOWN'); const plan = this.queueInput(input, []);
            if (this.scheduler.started) fail('SCHEDULER_ACTIVE'); const w = this.who(); this.batches.recover(w);
            return { recovered: true, scope: plan.scope, dispatchStarted: false, plan: this.queuePlan() };
        }), { maintenance: true }));
    }
    start(input) {
        return this.own(() => this.trackHost(async () => {
            await this.gates(); const plan = this.queueInput(input, ['automatic', 'recover']);
            if (input.recover !== false || typeof input.automatic !== 'boolean') fail('INVALID_REQUEST', 400);
            if (!this.proof.status().known || !(await this.host.readiness()).ready) fail('RUNTIME_NOT_READY', 503);
            await this.gates();
            // Never change an old epoch or resume a paused historical batch here.
            if (plan.pending.some(b => b.epoch !== this.who().epoch)) fail('HISTORICAL_QUEUE_REQUIRES_COMMAND');
            this.queueInput(input, ['automatic', 'recover']); this.who(); this.requireQueueProof();
            return this.scheduler.start({ automatic: input.automatic, recover: false });
        }));
    }
    command(batchId, input) {
        id(batchId); exact(input, ['clientCommandId', 'expectedVersion', 'action']);
        if (!['pause', 'resume', 'stop'].includes(input.action)) fail('INVALID_REQUEST', 400);
        return this.own(() => this.trackHost(async () => { const w = await this.gates(); this.requireRegistered(); if (!this.proof.status().known) fail('SCAN_PROOF_UNKNOWN'); return this.batches.command(w, batchId, input); }));
    }
    async dispose({ timeoutMs = 5000 } = {}) {
        const s = initial.get(this), { handle, scheduler, proof, upload, lib, db } = s;
        integer(timeoutMs, 0, 30000); this.closing = true; handle.dispose();
        const end = Date.now() + timeoutMs;
        await handle.drain({ timeoutMs });
        await scheduler.dispose({ timeoutMs: Math.max(0, end - Date.now()) });
        // Observer deadline never releases a permit, resolves work, closes an
        // inspection handle or destroys shared components.
        while ((this.operations.size || this.hostLeases.size) && Date.now() < end) await sleep();
        const settled = !this.operations.size && !this.hostLeases.size && !handle.state().active &&
            !scheduler.state().inflight && scheduler.closed && !scheduler.dispatchState().unknown &&
            scheduler.dispatchState().settled && !this.permits.size && upload.inspections.size === 0;
        const proofExit = settled ? proof.dispose() : { closed: false };
        this.closed = settled && proofExit.closed;
        if (this.closed) {
            if (owners.get(db) === this) owners.delete(db);
            if (owners.get(upload) === this) owners.delete(upload);
            if (diskOwners.get(this.diskKey) === this) diskOwners.delete(this.diskKey);
            if (lib.scanProof === proof) lib.scanProof = null;
        }
        return { closed: this.closed, unknown: !this.closed, activeHandlers: handle.state().active,
            sharedDatabaseClosed: false, sharedUploadClosed: false, sharedAuthClosed: false, sharedHostClosed: false };
    }
}
