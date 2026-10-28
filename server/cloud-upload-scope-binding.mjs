import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { identity, sameIdentity, canonical, clone, fingerprint, exact, id, segment, target, fail } from './cloud-upload-protocol.mjs';
import { libraryScopeSnapshot } from './cloud-upload-preview.mjs';

export const SCOPE_BINDING_LIMITS = Object.freeze({ tickets: 128, ttlMs: 60000, ticketBytes: 32768, totalBytes: 1048576, tokenBytes: 32 });
const required = (v, keys) => { exact(v, keys); if (Object.keys(v).length !== keys.length) fail('INVALID_REQUEST', 400); };
export function normalizeScopeVector(scopes, schema) {
    if (!['scope-null-v1', 'scope-omitted-v1'].includes(schema) || !Array.isArray(scopes) || !scopes.length || scopes.length > 32) fail('INVALID_REQUEST', 400);
    const result = scopes.map(s => {
        if (schema === 'scope-null-v1') required(s, ['rootId', 'category', 'subcategory']);
        else exact(s, ['rootId', 'category', 'subcategory']);
        id(s.rootId);
        const category = schema === 'scope-null-v1' ? s.category : Object.hasOwn(s, 'category') ? s.category : null;
        const subcategory = schema === 'scope-null-v1' ? s.subcategory : Object.hasOwn(s, 'subcategory') ? s.subcategory : null;
        for (const value of [category, subcategory]) if (value !== null) segment(value);
        if (schema === 'scope-omitted-v1' && ['category', 'subcategory'].some(k => Object.hasOwn(s, k) && (s[k] === null || s[k] === undefined))) fail('INVALID_REQUEST', 400);
        if (category === null && subcategory !== null) fail('INVALID_REQUEST', 400);
        return { rootId: s.rootId, category, subcategory };
    }).sort((a, b) => canonical(a) < canonical(b) ? -1 : canonical(a) > canonical(b) ? 1 : 0);
    if (new Set(result.map(canonical)).size !== result.length) fail('INVALID_REQUEST', 400);
    return result;
}
const providerScopes = scopes => scopes.map(s => ({ rootId: s.rootId, ...(s.category === null ? {} : { category: s.category }), ...(s.subcategory === null ? {} : { subcategory: s.subcategory }) }));
function commandPayload(input, scopeSchema = 'scope-null-v1') {
    id(input.clientCommandId); target(input.target);
    if (input.categoryOverride !== null) { required(input.categoryOverride, ['category', 'subcategory']); segment(input.categoryOverride.category); segment(input.categoryOverride.subcategory); if (!input.categoryOverride.category && input.categoryOverride.subcategory) fail('INVALID_REQUEST', 400); }
    return { clientCommandId: input.clientCommandId, scopes: normalizeScopeVector(input.scopes, scopeSchema), target: clone(input.target), categoryOverride: clone(input.categoryOverride) };
}
const size = value => Buffer.byteLength(canonical(value));

// Opaque, short-lived, per-instance capabilities. No global current selection,
// registration, DDL, filesystem enumeration, network or automatic scan.
export class CloudUploadScopeBinding {
    #tickets = new Map(); #totalBytes = 0; #last = -1;
    constructor({ lib, upload, provider, proof, currentIdentity, now = () => performance.now(), snapshotLimits = {} }) {
        if (!lib?.db || typeof upload?.inspectForBatch !== 'function' || typeof provider?.prepareSelection !== 'function' || typeof proof?.readBoundCertificate !== 'function' || typeof currentIdentity !== 'function' || typeof now !== 'function') fail('INVALID_ADAPTER');
        this.lib = lib; this.db = lib.db; this.upload = upload; this.provider = provider; this.proof = proof; this.currentIdentity = currentIdentity; this.now = now; this.snapshotLimits = snapshotLimits;
    }
    clock() { const t = this.now(); if (!Number.isFinite(t) || t < 0 || t < this.#last) fail('SCOPE_BINDING_STALE'); this.#last = t; return t; }
    guard(who, session) {
        identity(who); if (!sameIdentity(who, identity(this.currentIdentity()))) fail('AUTH_CHANGED');
        if (this.lib.db !== this.db || this.proof.db !== this.db) fail('SCOPE_BINDING_STALE');
        if (typeof session !== 'string' || !session.length || session.length > 128) fail('LOCAL_SESSION_REQUIRED', 401);
        return fingerprint({ session });
    }
    listRoots(who, input, { localSession } = {}) { this.guard(who, localSession); return this.provider.listRoots(input); }
    listCategories(who, input, { localSession } = {}) { this.guard(who, localSession); return this.provider.listCategories(input); }
    async issue(who, input, { localSession } = {}) {
        const sessionHash = this.guard(who, localSession);
        required(input, ['clientCommandId', 'scopeSchema', 'providerBinding', 'scopes', 'target', 'categoryOverride']);
        if (size(input) > SCOPE_BINDING_LIMITS.ticketBytes) fail('BODY_LIMIT', 413);
        id(input.providerBinding); const payload = commandPayload(input, input.scopeSchema), scopes = providerScopes(payload.scopes);
        const readiness = await this.provider.prepareSelection({ binding: input.providerBinding, scopes });
        this.guard(who, localSession);
        if (readiness.state !== 'PROVEN' || readiness.scanComplete !== true) fail('SCOPE_NOT_READY');
        const certificate = this.proof.readBoundCertificate({ rootVector: readiness.rootVector, scopes: readiness.scopes });
        if (certificate.known !== true || certificate.generation !== readiness.generation || certificate.sourceId !== who.librarySourceId) fail('SCOPE_BINDING_STALE');
        const audit = { schema: 'scope-binding-v1', who: clone(who), sessionHash, commandFingerprint: fingerprint(payload), certificate: clone(certificate) };
        const now = this.clock(), record = { audit, payload, expires: now + SCOPE_BINDING_LIMITS.ttlMs }, recordBytes = size(record);
        if (recordBytes > SCOPE_BINDING_LIMITS.ticketBytes) fail('BODY_LIMIT', 413);
        for (const [key, old] of this.#tickets) if (old.record.expires <= now && old.refs === 0) { this.#totalBytes -= old.bytes; this.#tickets.delete(key); }
        if (this.#tickets.size >= SCOPE_BINDING_LIMITS.tickets || this.#totalBytes + recordBytes > SCOPE_BINDING_LIMITS.totalBytes) fail('SCOPE_BINDING_LIMIT', 413);
        const token = randomBytes(SCOPE_BINDING_LIMITS.tokenBytes).toString('base64url');
        this.#tickets.set(token, { record, bytes: recordBytes, refs: 0 }); this.#totalBytes += recordBytes;
        return { scopeBinding: { schema: 'scope-binding-v1', token }, expiresInMs: SCOPE_BINDING_LIMITS.ttlMs };
    }
    verify(who, input, { localSession } = {}) {
        const sessionHash = this.guard(who, localSession), binding = input.scopeBinding;
        required(binding, ['schema', 'token']);
        if (binding.schema !== 'scope-binding-v1' || typeof binding.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(binding.token) || size(binding) > 128) fail('SCOPE_BINDING_INVALID');
        const entry = this.#tickets.get(binding.token), record = entry?.record;
        if (!record || record.expires <= this.clock()) fail('SCOPE_BINDING_STALE');
        if (entry.refs) fail('SCOPE_BINDING_BUSY', 423);
        if (!sameIdentity(record.audit.who, who) || sessionHash !== record.audit.sessionHash) fail('SCOPE_BINDING_INVALID');
        const payload = commandPayload(input);
        if (fingerprint(payload) !== record.audit.commandFingerprint) fail('IDEMPOTENCY_CONFLICT');
        const check = () => {
            this.guard(who, localSession);
            if (record.expires <= this.clock()) fail('SCOPE_BINDING_STALE');
            const expected = record.audit.certificate;
            const current = this.proof.readBoundCertificate({ rootVector: expected.rootVector, scopes: expected.scopes });
            if (current.known !== true || canonical(current) !== canonical(expected)) fail('SCOPE_BINDING_STALE');
            return current;
        };
        check(); entry.refs = 1; let released = false;
        const release = () => {
            if (released) return; released = true; entry.refs = 0;
            if (record.expires <= this.#last && this.#tickets.get(binding.token) === entry) { this.#tickets.delete(binding.token); this.#totalBytes -= entry.bytes; }
        };
        return { audit: clone(record.audit), payload, check, release };
    }
    async snapshot(who, input, binding) {
        binding.check();
        // Every request closes over its own binding, never a shared mutable selection.
        const readScanState = () => {
            const certificate = binding.check();
            return { scanComplete: true, offline: false, rootRevision: certificate.ledgerVersion, scanCompletedAt: Math.max(...certificate.completed.map(p => p.scanCompletedAt)) };
        };
        const snapshot = await libraryScopeSnapshot(this.lib, this.upload, readScanState, this.snapshotLimits)(who, binding.payload);
        binding.check(); const budgetCheck = snapshot.checkReadBudget;
        return { ...snapshot, checkReadBudget: () => { budgetCheck(); binding.check(); } };
    }
}
