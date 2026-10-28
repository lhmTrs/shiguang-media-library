import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const MAX = Number.MAX_SAFE_INTEGER;
const REG = 'cloud_upload_scan_registration', PROOF = 'cloud_upload_scan_proofs';
const FN = 'cloud_scan_writer';
const attachments = new Map(); // Trusted DB identity -> one supported, settled attachment.
const context = new AsyncLocalStorage();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const safe = (x, min = 0) => Number.isSafeInteger(x) && x >= min && x <= MAX;
const fail = (code = 'SCAN_PROOF_UNKNOWN') => { throw Object.assign(Error(code), { code, status: 409 }); };
const exact = (v, keys) => { if (!v || Object.getPrototypeOf(v) !== Object.prototype || Object.keys(v).some(k => !keys.includes(k))) fail('INVALID_REQUEST'); };
const boundedJson = (v, max) => { const raw = JSON.stringify(v); if (typeof raw !== 'string' || Buffer.byteLength(raw) > max) fail(); return raw; };
const normalized = s => s.trim().replace(/;$/, '');
const tableSql = {
    [REG]: `CREATE TABLE ${REG}(source_id TEXT PRIMARY KEY,registration_id TEXT NOT NULL,schema_version INTEGER NOT NULL CHECK(schema_version=1),db_identity_json TEXT NOT NULL,session_epoch TEXT NOT NULL,version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND ${MAX}),phase TEXT NOT NULL CHECK(phase='READY'))`,
    [PROOF]: `CREATE TABLE ${PROOF}(root_id TEXT PRIMARY KEY,generation INTEGER NOT NULL DEFAULT 0 CHECK(typeof(generation)='integer' AND generation BETWEEN 0 AND ${MAX}),lease_id TEXT NOT NULL DEFAULT '',owner_epoch TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'UNKNOWN' CHECK(state IN ('UNKNOWN','RUNNING','COMPLETE')),root_binding_json TEXT,root_revision INTEGER,reconciled_ms REAL,completed_ms INTEGER,error_code TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version BETWEEN 1 AND ${MAX}))`
};
function invalidateSql(root) {
    return `
      INSERT OR IGNORE INTO ${PROOF}(root_id) VALUES(${root});
      SELECT CASE WHEN (SELECT COUNT(*) FROM ${PROOF})>5000 THEN RAISE(ABORT,'SCAN_PROOF_LIMIT') END;
      SELECT CASE WHEN EXISTS(SELECT 1 FROM ${PROOF} WHERE root_id=${root} AND lease_id<>'' AND lease_id<>${FN}()) THEN RAISE(ABORT,'SCAN_PROOF_WRITER_BUSY') END;
      SELECT CASE WHEN EXISTS(SELECT 1 FROM ${PROOF} WHERE root_id=${root} AND (generation>=${MAX} OR version>=${MAX})) OR EXISTS(SELECT 1 FROM ${REG} WHERE version>=${MAX}) THEN RAISE(ABORT,'SCAN_PROOF_OVERFLOW') END;
      UPDATE ${REG} SET version=version+1;
      UPDATE ${PROOF} SET generation=generation+1,version=version+1,state=CASE WHEN lease_id='' THEN 'UNKNOWN' ELSE 'RUNNING' END,error_code='MUTATION' WHERE root_id=${root};`;
}
const triggerSql = {};
for (const table of ['roots', 'assets']) for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
    const name = `cloud_upload_scan_${table}_${operation.toLowerCase()}`;
    const column = table === 'roots' ? 'id' : 'root_id';
    const refs = operation === 'INSERT' ? [`NEW.${column}`] : operation === 'DELETE' ? [`OLD.${column}`] : [`OLD.${column}`, `NEW.${column}`];
    triggerSql[name] = `CREATE TRIGGER ${name} BEFORE ${operation} ON ${table} BEGIN ${refs.map(invalidateSql).join('\n')} END`;
}
const definitions = { ...tableSql, ...triggerSql };
// Reopening an already registered ledger needs its trigger function at SQL
// prepare time. These TEMP row fences force the rejecting callback even when
// the original lease predicate would short-circuit for an empty lease.
// No main schema, ledger, epoch or proof owner is created or changed here.
const bootstrapFences = Object.fromEntries(['assets', 'roots'].flatMap(table => ['INSERT','UPDATE','DELETE'].map(operation => {
    const name = `sg_scan_bootstrap_${table}_${operation.toLowerCase()}`;
    return [name, `CREATE TEMP TRIGGER ${name} BEFORE ${operation} ON main.${table} BEGIN SELECT ${FN}(); END`];
})));
const bootstrapFail = code => { throw Object.assign(Error(code), { code, status: 503 }); };
export function installPassiveScanProofFence(db) {
    if (db?.kind === 'mysql') return { known: false, supported: false, code: 'MYSQL_SCAN_PROOF_UNSUPPORTED' };
    if (!db || typeof db.prepare !== 'function' || typeof db.function !== 'function' || typeof db.transaction !== 'function' || db.inTransaction) bootstrapFail('SCAN_BOOTSTRAP_UNKNOWN');
    for (const owner of attachments.values()) if (!owner.closed && (owner.db === db || typeof db.name === 'string' && owner.db?.name === db.name)) bootstrapFail('SCAN_PROOF_OWNER_BUSY');
    const rows = db.prepare("SELECT name,type,substr(sql,1,65537) sql FROM sqlite_master WHERE name LIKE 'cloud_upload_scan_%' ORDER BY name LIMIT 17").all();
    const names = Object.keys(bootstrapFences), placeholders = names.map(() => '?').join(',');
    const temps = db.prepare(`SELECT name,type,substr(sql,1,65537) sql FROM sqlite_temp_master WHERE name IN (${placeholders}) ORDER BY name LIMIT 7`).all(...names);
    if (!rows.length && !temps.length) return { known: true, registered: false, temporaryObjects: 0 };
    if (rows.length !== Object.keys(definitions).length || rows.some(row => !definitions[row.name] || !row.sql || Buffer.byteLength(row.sql)>65536 || normalized(row.sql)!==normalized(definitions[row.name]) || row.type !== (row.name in tableSql ? 'table' : 'trigger'))) bootstrapFail('SCAN_BOOTSTRAP_SCHEMA_UNKNOWN');
    const validTemps = value => value.length === names.length && value.every(row => bootstrapFences[row.name] && row.type === 'trigger' && normalized(row.sql || '') === normalized(bootstrapFences[row.name].replace('CREATE TEMP TRIGGER','CREATE TRIGGER')));
    if (temps.length) {
        if (!validTemps(temps)) bootstrapFail('SCAN_BOOTSTRAP_TEMP_UNKNOWN');
        // SQLite cannot expose the JS callback identity. Never adopt, overwrite
        // or reinstall an existing function/TEMP binding, even exact SQL.
        bootstrapFail('SCAN_BOOTSTRAP_BINDING_UNKNOWN');
    }
    const functions = db.prepare("SELECT name,narg FROM pragma_function_list WHERE name=? AND builtin=0 LIMIT 2").all(FN);
    if (functions.length) bootstrapFail('SCAN_BOOTSTRAP_BINDING_UNKNOWN');
    db.function(FN, () => bootstrapFail('SCAN_PROOF_SESSION_REQUIRED'));
    try {
        db.transaction(() => {
            for (const sql of Object.values(bootstrapFences)) db.exec(sql);
            const installed = db.prepare(`SELECT name,type,substr(sql,1,65537) sql FROM sqlite_temp_master WHERE name IN (${placeholders}) ORDER BY name LIMIT 7`).all(...names);
            if (!validTemps(installed)) bootstrapFail('SCAN_BOOTSTRAP_TEMP_UNKNOWN');
        })();
    } catch { bootstrapFail('SCAN_BOOTSTRAP_INSTALL_FAILED'); }
    return { known: true, registered: true, requiresExplicitSession: true, temporaryObjects: names.length };
}
const rootShape = row => ({ rootId: row.id, path: row.path, name: row.name, kind: row.kind, online: row.online, retired: row.retired, revision: row.revision, reconciledMs: row.reconciled_ms });

// Only a server-owned capability can register/attach a supported private SQLite DB.
// No constructor queries, DDL, scans, timers or automatic recovery. The in-memory
// entry hook preserves legacy behavior only for a demonstrably absent ledger.
export class CloudUploadScanProof {
    constructor(lib, { capability, hook = async () => {} } = {}) {
        this.lib = lib; this.db = lib.db; this.capability = capability; this.hook = hook;
        this.active = new Map(); this.epoch = null; this.closed = false; this.pending = false; this.cache = null;
        if (!lib.scanProof) lib.scanProof = this;
    }
    identity() {
        if (this.lib.db !== this.db || this.db?.kind === 'mysql' || typeof this.db?.function !== 'function' || typeof this.capability?.identity !== 'function' || !uuid(this.capability.sourceId)) fail();
        const v = this.capability.identity();
        exact(v, ['dev', 'ino']); if (!safe(v.dev) || !safe(v.ino, 1)) fail();
        return { dev: v.dev, ino: v.ino };
    }
    schema({ functionRequired = true } = {}) {
        const identity = this.identity();
        const rows = this.db.prepare("SELECT name,substr(sql,1,65537) sql FROM sqlite_master WHERE name LIKE 'cloud_upload_scan_%' ORDER BY name LIMIT 16").all();
        if (rows.length !== Object.keys(definitions).length || rows.some(r => !definitions[r.name] || !r.sql || Buffer.byteLength(r.sql) > 65536 || normalized(r.sql) !== normalized(definitions[r.name]))) fail();
        const regs = this.db.prepare(`SELECT substr(source_id,1,37) source_id,substr(registration_id,1,37) registration_id,schema_version,substr(db_identity_json,1,1025) db_identity_json,substr(session_epoch,1,37) session_epoch,version,substr(phase,1,16) phase FROM ${REG} LIMIT 2`).all();
        const proofs = this.db.prepare(`SELECT substr(root_id,1,37) root_id,generation,substr(lease_id,1,37) lease_id,substr(owner_epoch,1,37) owner_epoch,substr(state,1,16) state,substr(root_binding_json,1,8193) root_binding_json,root_revision,reconciled_ms,completed_ms,substr(error_code,1,65) error_code,version FROM ${PROOF} ORDER BY root_id LIMIT 5001`).all();
        if (regs.length !== 1 || proofs.length > 5000) fail();
        const reg = regs[0];
        if (reg.source_id !== this.capability.sourceId || !uuid(reg.registration_id) || !uuid(reg.session_epoch) || reg.schema_version !== 1 || reg.phase !== 'READY' || !safe(reg.version, 1) || typeof reg.db_identity_json !== 'string' || Buffer.byteLength(reg.db_identity_json) > 1024 || reg.db_identity_json !== boundedJson(identity, 1024)) fail();
        for (const p of proofs) {
            if (!uuid(p.root_id) || !safe(p.generation) || !safe(p.version, 1) || !['UNKNOWN', 'RUNNING', 'COMPLETE'].includes(p.state) || p.lease_id !== '' && !uuid(p.lease_id) || p.owner_epoch !== '' && !uuid(p.owner_epoch) || typeof p.error_code !== 'string' || !/^[A-Z_]{0,64}$/.test(p.error_code)) fail();
            if (p.state === 'RUNNING' && (!p.lease_id || !p.owner_epoch) || p.state !== 'RUNNING' && p.lease_id) fail();
            if (p.root_revision !== null && !safe(p.root_revision) || p.reconciled_ms !== null && (!Number.isFinite(p.reconciled_ms) || p.reconciled_ms <= 0) || p.completed_ms !== null && !safe(p.completed_ms, 1)) fail();
            if (p.root_binding_json !== null) {
                if (typeof p.root_binding_json !== 'string' || Buffer.byteLength(p.root_binding_json) > 8192) fail();
                const bound = JSON.parse(p.root_binding_json);
                exact(bound, ['rootId', 'path', 'name', 'kind', 'online', 'retired', 'revision', 'reconciledMs']);
                if (bound.rootId !== p.root_id || !safe(bound.revision) || typeof bound.path !== 'string' || bound.path.length > 4096 || typeof bound.name !== 'string' || bound.name.length > 180 || !['music', 'sfx', 'mixed', 'photo', 'video'].includes(bound.kind) || ![0, 1].includes(bound.online) || ![0, 1].includes(bound.retired) || bound.reconciledMs !== null && (!Number.isFinite(bound.reconciledMs) || bound.reconciledMs <= 0)) fail();
            }
            if (p.state === 'COMPLETE' && (!p.root_binding_json || !safe(p.completed_ms, 1) || !safe(p.root_revision))) fail();
        }
        if (functionRequired) {
            const token = context.getStore(), expected = token?.service === this && this.active.get(token.rootId) === token ? token.id : '';
            if (this.db.prepare(`SELECT ${FN}() value`).get().value !== expected) fail();
        }
        return { reg, proofs, identity };
    }
    current() {
        if (this.closed || !this.epoch || attachments.get(this.key) !== this) fail();
        const value = this.schema(); if (value.reg.session_epoch !== this.epoch) fail(); return value;
    }
    quiet(ownJob, ownLease) {
        if (!(this.lib.jobs instanceof Map) || !(this.lib.locks instanceof Set) || this.lib.locks.size || !safe(this.lib.repairIndexReaders ?? 0) || (this.lib.repairIndexReaders ?? 0) !== 0 || this.lib.workers !== 0 || this.lib.metadataPending?.size !== 0 || this.lib.metadataQueue?.length !== 0) fail('SCAN_PROOF_BUSY');
        if (this.lib.jobs.size > 5000) fail('SCAN_PROOF_BUSY');
        for (const j of this.lib.jobs.values()) if (!(ownJob && j?.id === ownJob) && !(ownLease && j?.id === ownLease) && !['done', 'failed', 'partial', 'cancelled', 'interrupted'].includes(j?.status)) fail('SCAN_PROOF_BUSY');
        if (this.db.prepare("SELECT 1 FROM operations WHERE status='pending' LIMIT 1").get() || this.db.prepare("SELECT 1 FROM asset_repair_journal WHERE phase NOT IN ('COMPLETE','ABORTED') LIMIT 1").get()) fail('SCAN_PROOF_BUSY');
    }
    root(rootId) {
        if (!uuid(rootId)) fail('INVALID_REQUEST');
        const row = this.db.prepare('SELECT id,substr(path,1,4097) path,substr(name,1,181) name,kind,online,COALESCE(retired,0) retired,revision,reconciled_ms FROM roots WHERE id=?').get(rootId);
        if (!row || row.retired || !safe(row.revision) || typeof row.path !== 'string' || row.path.length > 4096 || typeof row.name !== 'string' || row.name.length > 180 || ![0, 1].includes(row.online) || row.reconciled_ms !== null && (!Number.isFinite(row.reconciled_ms) || row.reconciled_ms <= 0)) fail();
        const value = rootShape(row); boundedJson(value, 8192); return value;
    }
    installFunction() {
        this.db.function(FN, () => { const t = context.getStore(); return t?.service === this && this.active.get(t.rootId) === t ? t.id : ''; });
    }
    admissionGuard(identity) {
        if (this.closed || !this.pending || this.epoch || attachments.get(this.key) !== this || this.key !== boundedJson(identity, 1024) || this.capability.sourceId !== this.admissionSource || !same(identity, this.identity())) fail();
        this.quiet();
    }
    async admission(input, operation) {
        exact(input, ['clientCommandId', 'expectedVersion']);
        if (!uuid(input.clientCommandId) || !safe(input.expectedVersion) || this.pending || this.epoch || this.closed) fail('INVALID_REQUEST');
        const identity = this.identity(), key = boundedJson(identity, 1024);
        if (attachments.has(key)) fail('SCAN_PROOF_OWNER_BUSY');
        this.pending = true; this.key = key; this.admissionSource = this.capability.sourceId; attachments.set(key, this);
        try {
            if (await this.capability.authorize?.({ operation, database: this.db }) !== true) fail('SCAN_PROOF_REGISTRATION_DENIED');
            if (this.closed || this.capability.sourceId !== this.admissionSource || !same(identity, this.identity()) || attachments.get(key) !== this) fail();
            this.quiet(); return identity;
        } catch (error) { this.pending = false; if (attachments.get(key) === this) attachments.delete(key); throw error; }
    }
    async register(input) {
        const identity = await this.admission(input, 'REGISTER');
        try {
            this.admissionGuard(identity);
            if (input.expectedVersion !== 0 || this.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'cloud_upload_scan_%' LIMIT 1").get()) fail();
            const roots = this.db.prepare('SELECT id FROM roots ORDER BY id LIMIT 5001').all(); if (roots.length > 5000 || roots.some(r => !uuid(r.id))) fail();
            const epoch = randomUUID(); this.admissionGuard(identity); this.installFunction(); this.admissionGuard(identity);
            this.db.transaction(() => {
                this.admissionGuard(identity);
                for (const sql of Object.values(definitions)) this.db.exec(sql);
                this.db.prepare(`INSERT INTO ${REG} VALUES(?,?,?,?,?,?,'READY')`).run(this.capability.sourceId, input.clientCommandId, 1, boundedJson(identity, 1024), epoch, 1);
                const insert = this.db.prepare(`INSERT INTO ${PROOF}(root_id) VALUES(?)`); for (const r of roots) insert.run(r.id);
            })();
            this.epoch = epoch; this.schema(); this.lib.scanProof = this; return this.status();
        } finally { this.pending = false; if (!this.epoch && attachments.get(this.key) === this) attachments.delete(this.key); }
    }
    async openSession(input) {
        const identity = await this.admission(input, 'OPEN_SESSION');
        try {
            this.admissionGuard(identity);
            const value = this.schema({ functionRequired: false });
            if (value.reg.version !== input.expectedVersion || value.proofs.some(p => p.lease_id)) fail('SCAN_PROOF_OWNER_UNKNOWN');
            if (value.reg.version >= MAX || value.proofs.some(p => p.generation >= MAX || p.version >= MAX)) fail('SCAN_PROOF_OVERFLOW');
            const epoch = randomUUID(); this.admissionGuard(identity); this.installFunction(); this.admissionGuard(identity);
            this.db.transaction(() => {
                this.admissionGuard(identity);
                if (this.db.prepare(`UPDATE ${REG} SET session_epoch=?,version=version+1 WHERE version=? AND session_epoch=?`).run(epoch, value.reg.version, value.reg.session_epoch).changes !== 1) fail();
                this.db.prepare(`UPDATE ${PROOF} SET generation=generation+1,version=version+1,state='UNKNOWN',error_code='NEW_SESSION' WHERE lease_id=''`).run();
            })();
            this.epoch = epoch; this.lib.scanProof = this; return this.status();
        } finally { this.pending = false; if (!this.epoch && attachments.get(this.key) === this) attachments.delete(this.key); }
    }
    status() { try { const v = this.current(); return { known: true, registered: true, version: v.reg.version, active: this.active.size }; } catch { return { known: false, registered: false, code: 'SCAN_PROOF_UNKNOWN', active: this.active.size }; } }
    begin(rootId, mode, job) {
        if (!['FULL', 'SCAN', 'QUICK', 'MANIFEST'].includes(mode)) fail();
        const v = this.current(); this.quiet(job?.id);
        if (this.active.size || v.proofs.some(p => p.lease_id)) fail('SCAN_PROOF_OWNER_BUSY');
        if (this.lib.jobs.size >= 5000) fail('SCAN_PROOF_BUSY');
        const root = this.root(rootId), p = v.proofs.find(p => p.root_id === rootId);
        if (!p || p.generation >= MAX || p.version >= MAX || v.reg.version >= MAX) fail('SCAN_PROOF_OVERFLOW');
        const token = { service: this, id: randomUUID(), rootId, root, mode, job, cancelled: false };
        this.db.transaction(() => {
            if (this.db.prepare(`UPDATE ${PROOF} SET lease_id=?,owner_epoch=?,state='RUNNING',generation=generation+1,version=version+1,error_code='' WHERE root_id=? AND lease_id='' AND generation=? AND version=?`).run(token.id, this.epoch, rootId, p.generation, p.version).changes !== 1) fail();
            if (this.db.prepare(`UPDATE ${REG} SET version=version+1 WHERE session_epoch=? AND version=?`).run(this.epoch, v.reg.version).changes !== 1) fail();
        })();
        this.active.set(rootId, token);
        // Original file-operation guards already reject running jobs before FS work.
        this.lib.jobs.set(token.id, { id: token.id, rootId, type: 'scan-proof', label: '扫描证据核对', status: 'running', errors: [] });
        return token;
    }
    fullResult(token, result) {
        if (token.mode === 'SCAN') return token.job?.status === 'done' && Array.isArray(token.job.errors) && token.job.errors.length === 0;
        return token.mode === 'FULL' && result?.mode === 'full' && result.rootId === token.rootId && result.rootReachable === true && Array.isArray(result.walkErrors) && !result.walkErrors.length && Array.isArray(result.conflicts) && !result.conflicts.length && !['deferred', 'repairPending', 'registrationChanged', 'manifestWriteError', 'hashBudgetExhausted'].some(k => result[k]);
    }
    async run(rootId, mode, work, { signal, job } = {}) {
        if (this.closed || this.lib.db !== this.db) fail();
        if (!this.epoch) {
            if (this.db?.kind === 'mysql') return work(); // Legacy work only, never positive proof.
            if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name LIKE 'cloud_upload_scan_%' LIMIT 1").get()) return work();
            fail(); // Registered/partial/reopened ledger requires explicit admission before FS.
        }
        if (signal !== undefined && !(signal instanceof AbortSignal)) fail('INVALID_REQUEST');
        const token = this.begin(rootId, mode, job), abort = () => { token.cancelled = true; };
        if (signal?.aborted) abort(); signal?.addEventListener('abort', abort, { once: true });
        let result, error, observation;
        if (mode === 'SCAN') this.lib.repairIndexReaders = (this.lib.repairIndexReaders ?? 0) + 1;
        try {
            if (token.cancelled) fail('SCAN_PROOF_CANCELLED');
            result = await context.run(token, work);
        } catch (e) { error = e; }
        finally {
            if (mode === 'SCAN') { const count = this.lib.repairIndexReaders; this.lib.repairIndexReaders = safe(count, 1) ? count - 1 : NaN; }
        }
        // No timeout race; work and its actual I/O/finally have already settled here.
        try {
            const current = this.schema(); observation = current.proofs.find(p => p.root_id === rootId);
            await this.hook('before-cas', { rootId, mode, leaseId: token.id });
            this.db.transaction(() => {
                const v = this.schema(), p = v.proofs.find(p => p.root_id === rootId);
                if (!p || p.lease_id !== token.id || p.owner_epoch !== this.epoch || v.reg.session_epoch !== this.epoch || p.version >= MAX || v.reg.version >= MAX) fail();
                let root; try { root = this.root(rootId); } catch {}
                let quiet = true; try { this.quiet(job?.id, token.id); } catch { quiet = false; }
                const complete = !error && !token.cancelled && !this.closed && quiet && this.fullResult(token, result) && p.generation === observation?.generation && p.version === observation?.version && root?.online === 1 && ['rootId', 'path', 'name', 'kind', 'retired'].every(k => root[k] === token.root[k]);
                const code = complete ? '' : token.cancelled ? 'CANCELLED' : error ? 'WORK_FAILED' : 'NOT_COMPLETE';
                const now = Date.now(); if (complete && !safe(now, 1)) fail();
                const changes = this.db.prepare(`UPDATE ${PROOF} SET state=?,lease_id='',version=version+1,error_code=?,root_binding_json=?,root_revision=?,reconciled_ms=?,completed_ms=? WHERE root_id=? AND lease_id=? AND owner_epoch=? AND generation=? AND version=?`).run(complete ? 'COMPLETE' : 'UNKNOWN', code, complete ? boundedJson(root, 8192) : p.root_binding_json, complete ? root.revision : p.root_revision, complete ? root.reconciledMs : p.reconciled_ms, complete ? now : p.completed_ms, rootId, token.id, this.epoch, p.generation, p.version).changes;
                if (changes !== 1) fail();
                if (this.db.prepare(`UPDATE ${REG} SET version=version+1 WHERE session_epoch=? AND version=?`).run(this.epoch, v.reg.version).changes !== 1) fail();
            })();
            this.active.delete(rootId);
            const evidenceJob = this.lib.jobs.get(token.id); if (evidenceJob) evidenceJob.status = error || token.cancelled ? 'failed' : 'done';
        } catch { token.unknown = true; if (!error) error = Object.assign(Error('SCAN_PROOF_UNKNOWN'), { code: 'SCAN_PROOF_UNKNOWN' }); }
        finally { signal?.removeEventListener('abort', abort); }
        if (error) throw error;
        if (token.cancelled) fail('SCAN_PROOF_CANCELLED');
        return result;
    }
    readCompletion(request) {
        const certificate = this.readCertificateCore(request, false);
        if (!certificate.known) return certificate;
        return Object.fromEntries(['known', 'complete', 'generation', 'rootVector', 'scopes', 'completed'].map(k => [k, certificate[k]]));
    }
    readBoundCertificate(request) { return this.readCertificateCore(request, true); }
    readCertificateCore(request, requireDescriptor) {
        try {
            exact(request, ['rootVector', 'scopes']);
            if (!Array.isArray(request.rootVector) || !request.rootVector.length || request.rootVector.length > 32 || !Array.isArray(request.scopes)) fail();
            if (!request.scopes.length || request.scopes.length > 32 || new Set(request.rootVector.map(r => r.rootId)).size !== request.rootVector.length) fail();
            for (const r of request.rootVector) { exact(r, ['rootId', 'revision', 'reconciledMs']); if (!uuid(r.rootId) || !safe(r.revision) || r.reconciledMs !== null && (!Number.isFinite(r.reconciledMs) || r.reconciledMs <= 0)) fail(); }
            for (const s of request.scopes) {
                exact(s, ['rootId', 'category', 'subcategory']);
                if (!request.rootVector.some(r => r.rootId === s.rootId) || s.subcategory !== undefined && s.category === undefined) fail();
                for (const key of ['category', 'subcategory']) if (s[key] !== undefined && (typeof s[key] !== 'string' || s[key].length > 60 || /[\x00-\x1f\x7f-\x9f\\/:]/.test(s[key]) || s[key] !== s[key].trim() || ['.', '..'].includes(s[key]))) fail();
            }
            boundedJson(request, 32768);
            return this.db.transaction(() => {
            const v = this.current(); this.quiet();
            let descriptor = null;
            if (requireDescriptor) {
                descriptor = this.capability.descriptor?.();
                exact(descriptor, ['engine', 'dev', 'ino', 'birthtimeMs', 'sourceId']);
                if (descriptor.engine !== 'sqlite' || descriptor.sourceId !== v.reg.source_id || descriptor.dev !== v.identity.dev || descriptor.ino !== v.identity.ino || !Number.isFinite(descriptor.birthtimeMs) || descriptor.birthtimeMs <= 0) fail();
            }
            if (v.reg.version >= MAX || v.proofs.some(p => p.generation >= MAX || p.version >= MAX)) fail();
            if (this.active.size || v.proofs.some(p => p.lease_id)) fail();
            const completed = [];
            for (const wanted of request.rootVector) {
                const p = v.proofs.find(p => p.root_id === wanted.rootId), root = this.root(wanted.rootId);
                if (!p || p.state !== 'COMPLETE' || p.owner_epoch !== this.epoch || p.root_binding_json !== boundedJson(root, 8192) || root.online !== 1 || root.revision !== wanted.revision || root.reconciledMs !== wanted.reconciledMs) fail();
                completed.push({ rootId: wanted.rootId, coverage: 'FULL', errors: 0, scanCompletedAt: p.completed_ms });
            }
            const key = JSON.stringify([this.epoch, v.reg.version]);
            if (this.cache?.key !== key) this.cache = { key, generation: randomUUID() };
            return { known: true, complete: true, generation: this.cache.generation, rootVector: JSON.parse(JSON.stringify(request.rootVector)), scopes: JSON.parse(JSON.stringify(request.scopes)), completed,
                ledgerVersion: v.reg.version, sessionEpoch: v.reg.session_epoch, sourceId: v.reg.source_id, dbIdentity: v.identity, descriptor,
                proofVector: request.rootVector.map(r => { const p = v.proofs.find(p => p.root_id === r.rootId); return { rootId: r.rootId, generation: p.generation, version: p.version }; }) };
            })();
        } catch { return { known: false, complete: false, code: 'SCAN_PROOF_UNKNOWN' }; }
    }
    dispose() {
        this.closed = true; for (const token of this.active.values()) token.cancelled = true;
        const closed = !this.pending && this.active.size === 0;
        if (closed && attachments.get(this.key) === this) attachments.delete(this.key);
        return { closed, unknown: !closed, sharedDatabaseClosed: false };
    }
}
