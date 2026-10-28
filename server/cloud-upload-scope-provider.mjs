import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// Index metadata only. No filesystem, upload, network, DDL or automatic work.
export const SCOPE_PROVIDER_LIMITS = Object.freeze({ items: 5000, page: 100, pageBytes: 65536, snapshotBytes: 1048576, roots: 32, tokens: 128, ttlMs: 60000 });
const fail = (code, status = 409) => { throw Object.assign(Error(code), { code, status }); };
const copy = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const exact = (value, keys) => {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(k => !keys.includes(k))) fail('INVALID_REQUEST', 400);
};
const integer = (n, min, max) => { if (!Number.isSafeInteger(n) || n < min || n > max) fail('INVALID_REQUEST', 400); };
const uuid = value => { if (typeof value !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) fail('INVALID_REQUEST', 400); return value; };
const segment = (value, max = 60) => {
    if (typeof value !== 'string' || value.length > max || value !== value.trim() || /[\x00-\x1f\x7f-\x9f\\/:]/.test(value) || value === '.' || value === '..') fail('SCOPE_METADATA_INVALID');
    return value;
};
const scopeKey = s => JSON.stringify([s.rootId, s.category ?? null, s.subcategory ?? null]);

export function createCloudUploadScopeProvider(lib, { readCompletion, now = () => performance.now() } = {}) {
    if (!lib || typeof now !== 'function' || readCompletion !== undefined && typeof readCompletion !== 'function') fail('INVALID_REQUEST', 400);
    // Database identity is pinned; replacing lib.db requires a new provider.
    const db = lib.db, tokens = new Map();
    let lastTime = -1;
    const clock = () => { const t = now(); if (!Number.isFinite(t) || t < 0 || t < lastTime) fail('SCOPE_NOT_READY'); lastTime = t; return t; };
    const checkDb = () => { if (lib.db !== db || !db || db.kind === 'mysql' || typeof db.transaction !== 'function') fail('SCOPE_NOT_READY'); };
    const withinBytes = value => { if (bytes(value) > SCOPE_PROVIDER_LIMITS.snapshotBytes) fail('SCOPE_BUDGET_EXCEEDED', 413); };
    const remember = value => {
        const t = clock();
        for (const [key, entry] of tokens) if (entry.expires <= t) tokens.delete(key);
        if (tokens.size >= SCOPE_PROVIDER_LIMITS.tokens) fail('SCOPE_BUDGET_EXCEEDED', 413);
        const token = randomUUID(); tokens.set(token, { ...value, expires: t + SCOPE_PROVIDER_LIMITS.ttlMs }); return token;
    };
    const lookup = token => {
        uuid(token); const entry = tokens.get(token);
        if (!entry || entry.expires <= clock()) fail('SCOPE_CURSOR_INVALID');
        return entry;
    };
    function snapshot(rootIds) {
        checkDb();
        return db.transaction(() => {
            // Fixed row limits include a sentinel; excess never means a complete truncated projection.
            const roots = db.prepare(`SELECT substr(id,1,37) id,substr(path,1,4097) path,substr(name,1,181) name,substr(kind,1,20) kind,online,retired,revision,reconciled_ms FROM roots WHERE COALESCE(retired,0)=0 AND kind IN ('music','sfx','mixed') ORDER BY id LIMIT 5001`).all();
            if (roots.length > SCOPE_PROVIDER_LIMITS.items) fail('SCOPE_BUDGET_EXCEEDED', 413);
            for (const root of roots) {
                uuid(root.id); segment(root.name, 180);
                if (!root.name || typeof root.path !== 'string' || root.path.length > 4096 || ![0, 1].includes(root.online) || !Number.isSafeInteger(root.revision) || root.revision < 0 || root.reconciled_ms !== null && (!Number.isFinite(root.reconciled_ms) || root.reconciled_ms <= 0)) fail('SCOPE_METADATA_INVALID');
            }
            withinBytes(roots);
            if (!rootIds) return { roots };
            const selected = rootIds.map(rootId => roots.find(r => r.id === rootId));
            if (selected.some(r => !r)) fail('SCOPE_CHANGED');
            const marks = rootIds.map(() => '?').join(',');
            // Same source predicates as the optional batch snapshot adapter, no media access.
            const assets = db.prepare(`SELECT substr(id,1,37) id,root_id,substr(category,1,61) category,substr(sub,1,61) sub FROM assets WHERE root_id IN (${marks}) AND kind IN ('music','sfx') AND trashed=0 AND online=1 AND COALESCE(file_status,'unknown')<>'missing' ORDER BY id LIMIT 5001`).all(...rootIds);
            if (assets.length > SCOPE_PROVIDER_LIMITS.items) fail('ITEM_LIMIT', 413);
            for (const row of assets) { uuid(row.id); segment(row.category); segment(row.sub); if (!row.category && row.sub) fail('SCOPE_METADATA_INVALID'); }
            // Binding includes exact asset membership as well as categories: same revision alone is insufficient.
            const result = { roots: selected, assets }; withinBytes(result); return result;
        })();
    }
    const projectRoots = view => view.roots.map(r => ({ rootId: r.id, name: r.name, kind: r.kind, online: r.online === 1 }));
    const projectCategories = view => {
        const choices = new Map();
        for (const row of view.assets) {
            if (row.category) { const s = { rootId: row.root_id, category: row.category }; choices.set(scopeKey(s), s); }
            const s = { rootId: row.root_id, category: row.category, subcategory: row.sub }; choices.set(scopeKey(s), s);
        }
        return [...choices.values()].sort((a, b) => scopeKey(a) < scopeKey(b) ? -1 : scopeKey(a) > scopeKey(b) ? 1 : 0);
    };
    function page(type, input) {
        exact(input, type === 'roots' ? ['limit', 'maxBytes', 'cursor'] : ['rootIds', 'limit', 'maxBytes', 'cursor']);
        const limit = input.limit ?? SCOPE_PROVIDER_LIMITS.page, maxBytes = input.maxBytes ?? SCOPE_PROVIDER_LIMITS.pageBytes;
        integer(limit, 1, SCOPE_PROVIDER_LIMITS.page); integer(maxBytes, 1, SCOPE_PROVIDER_LIMITS.pageBytes);
        let rootIds;
        if (type === 'categories') {
            if (!Array.isArray(input.rootIds) || !input.rootIds.length || input.rootIds.length > SCOPE_PROVIDER_LIMITS.roots) fail('INVALID_REQUEST', 400);
            rootIds = input.rootIds.map(uuid).sort(); if (new Set(rootIds).size !== rootIds.length) fail('INVALID_REQUEST', 400);
        }
        let view, offset = 0, binding;
        if (input.cursor !== undefined) {
            const previous = lookup(input.cursor);
            if (previous.type !== type || previous.limit !== limit || previous.maxBytes !== maxBytes || !same(previous.rootIds, rootIds)) fail('SCOPE_CURSOR_INVALID');
            view = snapshot(rootIds);
            if (!same(view, previous.view)) fail('SCOPE_CHANGED');
            offset = previous.offset; binding = previous.binding;
            lookup(binding);
        } else {
            view = snapshot(rootIds); binding = remember({ type: 'binding', source: type, rootIds, view });
        }
        const all = type === 'roots' ? projectRoots(view) : projectCategories(view), rows = [];
        // Reserve the fixed size of a possible opaque next cursor before selecting any rows.
        const envelope = { rows, binding, nextCursor: '0'.repeat(36), hasMore: true };
        if (bytes(envelope) > maxBytes) fail('SCOPE_BUDGET_EXCEEDED', 413);
        while (offset + rows.length < all.length && rows.length < limit) {
            rows.push(all[offset + rows.length]);
            if (bytes(envelope) > maxBytes) { rows.pop(); break; }
        }
        if (!rows.length && offset < all.length) fail('SCOPE_BUDGET_EXCEEDED', 413);
        const next = offset + rows.length, hasMore = next < all.length;
        const nextCursor = hasMore ? remember({ type, rootIds, view, binding, offset: next, limit, maxBytes }) : null;
        return { rows: copy(rows), binding, nextCursor, hasMore };
    }
    function activity() {
        if (!(lib.jobs instanceof Map) || !(lib.locks instanceof Set) || !Number.isSafeInteger(lib.repairIndexReaders) || lib.repairIndexReaders < 0) return 'ACTIVITY_UNPROVEN';
        const jobs = [...lib.jobs.values()];
        if (jobs.some(j => !j || !['pending', 'queued', 'running', 'cancelling', 'done', 'failed', 'partial', 'cancelled', 'interrupted'].includes(j.status))) return 'ACTIVITY_UNPROVEN';
        if (lib.repairIndexReaders || lib.locks.size || jobs.some(j => ['pending', 'queued', 'running', 'cancelling'].includes(j.status))) return 'ACTIVITY_BUSY';
        return null;
    }
    const vector = view => view.roots.map(r => ({ rootId: r.id, revision: r.revision, reconciledMs: r.reconciled_ms }));
    const unproven = (view, reason) => ({ state: 'UNPROVEN', code: 'SCOPE_NOT_READY', scanComplete: false, rootVector: vector(view), missing: [reason] });
    function validProof(proof, request) {
        if (!proof || Object.keys(proof).some(k => !['known', 'complete', 'generation', 'rootVector', 'scopes', 'completed'].includes(k)) || proof.known !== true || proof.complete !== true || typeof proof.generation !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(proof.generation) || !same(proof.rootVector, request.rootVector) || !same(proof.scopes, request.scopes) || !Array.isArray(proof.completed) || proof.completed.length !== request.rootVector.length) return false;
        return proof.completed.every((p, i) => p && Object.keys(p).every(k => ['rootId', 'coverage', 'errors', 'scanCompletedAt'].includes(k)) && p.rootId === request.rootVector[i].rootId && p.coverage === 'FULL' && p.errors === 0 && Number.isSafeInteger(p.scanCompletedAt) && p.scanCompletedAt > 0);
    }
    async function prepareSelection(input) {
        exact(input, ['binding', 'scopes']);
        const binding = lookup(input.binding);
        if (binding.type !== 'binding' || binding.source !== 'categories') fail('SCOPE_CURSOR_INVALID');
        if (!Array.isArray(input.scopes) || !input.scopes.length || input.scopes.length > SCOPE_PROVIDER_LIMITS.roots) fail('INVALID_REQUEST', 400);
        const scopes = input.scopes.map(s => {
            exact(s, ['rootId', 'category', 'subcategory']); uuid(s.rootId);
            if (s.category !== undefined) segment(s.category);
            if (s.subcategory !== undefined) { segment(s.subcategory); if (s.category === undefined) fail('INVALID_REQUEST', 400); }
            return copy(s);
        }).sort((a, b) => scopeKey(a) < scopeKey(b) ? -1 : 1);
        if (new Set(scopes.map(scopeKey)).size !== scopes.length) fail('INVALID_REQUEST', 400);
        let before = snapshot(binding.rootIds);
        if (!same(before, binding.view)) fail('SCOPE_CHANGED');
        const choices = new Set(projectCategories(before).map(scopeKey));
        for (const s of scopes) if (!binding.rootIds.includes(s.rootId) || s.category !== undefined && !choices.has(scopeKey(s))) fail('SCOPE_CHANGED');
        if (before.roots.some(r => r.online !== 1)) return unproven(before, 'ROOT_OFFLINE');
        const busy = activity(); if (busy) return unproven(before, busy);
        if (!readCompletion) return unproven(before, 'FULL_SCAN_PROOF_READER_MISSING');
        const request = { rootVector: vector(before), scopes };
        let first, second;
        try {
            first = copy(await readCompletion(copy(request)));
            if (validProof(first, request)) second = copy(await readCompletion(copy(request)));
        } catch { second = null; }
        checkDb(); lookup(input.binding);
        const after = snapshot(binding.rootIds);
        if (!same(before, after)) fail('SCOPE_CHANGED');
        const finalBusy = activity(); if (finalBusy) return unproven(after, finalBusy);
        if (!validProof(first, request)) return unproven(after, 'FULL_SCAN_PROOF_UNPROVEN');
        if (!validProof(second, request) || !same(first, second)) return unproven(after, 'FULL_SCAN_PROOF_CHANGED');
        // Vector is deliberately not collapsed into the scalar rootRevision expected by04B2.
        return { state: 'PROVEN', scanComplete: true, rootVector: vector(after), scopes: copy(scopes), completed: copy(second.completed), generation: second.generation };
    }
    return Object.freeze({ listRoots: (input = {}) => page('roots', input), listCategories: (input = {}) => page('categories', input), prepareSelection });
}
