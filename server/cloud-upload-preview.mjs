import { performance } from 'node:perf_hooks';
import { CloudUploadCommands } from './cloud-upload-commands.mjs';
import { LIMITS, identity, namespace, sameIdentity, exact, body, id, hash, text, integer, segment, target, asset, sourceVersion, clone, uuid, fingerprint, canonical, groupFingerprint, groupKey, metadataFingerprint, publicItem, cursor, readCursor, fail } from './cloud-upload-protocol.mjs';
export const PREVIEW_READ_LIMITS=Object.freeze({maxBytes:128*1024*1024,timeoutMs:10000});
const readBudgets=new WeakSet();
export const isPreviewReadBudget=value=>!!value&&readBudgets.has(value);
// One shared actual-read counter and monotonic deadline per whole snapshot. No file-size precharge.
export function createPreviewReadBudget({maxBytes=PREVIEW_READ_LIMITS.maxBytes,timeoutMs=PREVIEW_READ_LIMITS.timeoutMs,now=()=>performance.now(),signal}={}){
    integer(maxBytes,0,PREVIEW_READ_LIMITS.maxBytes);integer(timeoutMs,0,PREVIEW_READ_LIMITS.timeoutMs);
    if(typeof now!=='function'||signal!==undefined&&!(signal instanceof AbortSignal))fail('INVALID_REQUEST',400);
    const startedAt=now();if(!Number.isFinite(startedAt)||startedAt<0)fail('INVALID_REQUEST',400);
    const deadline=startedAt+timeoutMs;let last=startedAt,bytesRead=0,reservedBytes=0,unknown=false,expired=false,cancelled=false;
    const check=()=>{if(signal?.aborted){cancelled=true;fail('PREVIEW_CANCELLED',409);}const current=now();if(!Number.isFinite(current)||current<last||current>=deadline){expired=true;fail('PREVIEW_BUDGET_EXCEEDED',413);}last=current;if(unknown)fail('PREVIEW_BUDGET_EXCEEDED',413);};
    const budget=Object.freeze({check,state:()=>({maxBytes,timeoutMs,bytesRead,reservedBytes,remainingBytes:unknown?0:Math.max(0,maxBytes-bytesRead-reservedBytes),startedAt,deadline,unknown,expired,cancelled}),
        async read(requested,read){
            check();integer(requested,1,65536);if(typeof read!=='function')fail('INVALID_REQUEST',400);
            // Reserve only the next actual syscall's maximum, allowing concurrent readers to share the hard cap.
            const length=Math.min(requested,maxBytes-bytesRead-reservedBytes);if(length<1)fail('PREVIEW_BUDGET_EXCEEDED',413);reservedBytes+=length;let observed=false;
            try{const result=await read(length);if(!Number.isSafeInteger(result?.bytesRead)||result.bytesRead<0||result.bytesRead>length)fail('SOURCE_CHANGED');bytesRead+=result.bytesRead;observed=true;reservedBytes-=length;check();return result;}
            catch(error){if(!observed){reservedBytes-=length;unknown=true;}throw error;}
        }
    });readBudgets.add(budget);return budget;
}
const T = 'cloud_upload_preview_items';
export class CloudUploadPreview {
    constructor(store, { currentIdentity, snapshotScope, scopeBindings, scopeBindingPolicy = 'required' } = {}) { if (typeof currentIdentity !== 'function' || typeof snapshotScope !== 'function' || !['required', 'legacy-controlled'].includes(scopeBindingPolicy))
        fail('INVALID_ADAPTER'); this.store = store; this.currentIdentity = currentIdentity; this.snapshotScope = snapshotScope; this.commands = new CloudUploadCommands(store); this.scopeBindings = scopeBindings; this.scopeBindingPolicy = scopeBindingPolicy; }
    guard(who) { identity(who); if (!sameIdentity(who, identity(this.currentIdentity())))
        fail('AUTH_CHANGED'); }
    owned(who, previewId) { this.guard(who); const p = this.store.get('cloud_upload_previews', { previewId: id(previewId), ...namespace(who) }); if (!p || !sameIdentity(p, who, false))
        fail('NOT_FOUND', 404); return p; }
    rows(previewId) { return this.store.list(T, { previewId }, { order: 'ordinal' }); }
    view(p) { return { previewId: p.previewId, version: p.version, manifestFingerprint: p.manifestFingerprint, state: p.status, totalFrozen: p.totalFrozen, scanCompletedAt: p.scanCompletedAt }; }
    manifest(p, rows) { return fingerprint({ scopes: p.scope, target: p.target, rootRevision: p.rootRevision, items: rows.map(r => ({ assetId: r.assetId, included: r.included, sourceVersion: r.sourceVersion, sha256: r.sha256, metadata: metadataFingerprint(r), representativeAssetId: r.representativeAssetId })) }); }
    resolveCreate(who, clientCommandId) {
        this.guard(who); id(clientCommandId);
        const command = this.store.get('cloud_upload_commands', { ...namespace(who), clientCommandId });
        const unknown = { state: 'UNKNOWN', historicalFact: true, currentScopePermission: false, preview: null };
        if (!command || command.targetKind !== 'preview' || command.action !== 'create' || !command.result?.previewId) return unknown;
        const p = this.store.get('cloud_upload_previews', { previewId: id(command.result.previewId), ...namespace(who) });
        if (!p) return unknown;
        if (!sameIdentity(p, who, false)) fail('NOT_FOUND', 404);
        return { state: 'FOUND', historicalFact: true, currentScopePermission: false, preview: clone(command.result) };
    }
    async create(who, input, { localSession } = {}) {
        this.guard(who);
        input = clone(input);
        body(input);
        exact(input, ['clientCommandId', 'scopes', 'target', 'categoryOverride', 'scopeBinding']);
        let bound = null;
        try {
        if (this.scopeBindingPolicy === 'required') {
            if (!input.scopeBinding || typeof this.scopeBindings?.verify !== 'function' || typeof this.scopeBindings?.snapshot !== 'function' || this.scopeBindings.db !== this.store.db) fail('SCOPE_BINDING_REQUIRED');
            bound = this.scopeBindings.verify(who, input, { localSession });
            input = { ...clone(bound.payload), scopeBinding: input.scopeBinding };
        } else if (input.scopeBinding !== undefined) fail('INVALID_REQUEST', 400);
        id(input.clientCommandId);
        target(input.target);
        if (!Array.isArray(input.scopes) || !input.scopes.length || input.scopes.length > 100)
            fail('INVALID_REQUEST', 400);
        for (const scope of input.scopes) {
            exact(scope, ['rootId', 'category', 'subcategory']);
            id(scope.rootId);
            for (const k of ['category', 'subcategory'])
                if (scope[k] !== null)
                    text(scope[k], 60, true);
        }
        if (input.categoryOverride !== undefined && input.categoryOverride !== null) {
            exact(input.categoryOverride, ['category', 'subcategory']);
            segment(input.categoryOverride.category);
            segment(input.categoryOverride.subcategory);
            if (!input.categoryOverride.category && input.categoryOverride.subcategory)
                fail('INVALID_REQUEST', 400);
        }
        const payload = bound ? { ...clone(bound.payload), scopeBindingProof: clone(bound.audit) } : input;
        const cmd = { clientCommandId: input.clientCommandId, targetKind: 'preview', targetId: input.clientCommandId, action: 'create', expectedVersion: 0, payload }, old = this.commands.replay(who, cmd);
        if (old)
            return old;
        const snapshot = bound ? await this.scopeBindings.snapshot(clone(who), clone(input), bound) : await this.snapshotScope(clone(who), clone(input));
        this.guard(who);snapshot.checkReadBudget?.();
        if (snapshot.scanComplete !== true || snapshot.offline === true)
            fail('SCOPE_NOT_READY');
        integer(snapshot.rootRevision);
        integer(snapshot.scanCompletedAt, 1);
        if (!Array.isArray(snapshot.items) || snapshot.items.length > LIMITS.items)
            fail('ITEM_LIMIT', 413);
        const unique = new Map();
        for (const raw of snapshot.items) {
            const r = asset(raw);
            if (!input.scopes.some(s => s.rootId === r.rootId && (s.category === null || s.category === r.category) && (s.subcategory === null || s.subcategory === r.subcategory)))
                fail('SCOPE_CHANGED');
            if (unique.has(r.assetId) && canonical(unique.get(r.assetId)) !== canonical(r))
                fail('SOURCE_CHANGED');
            unique.set(r.assetId, r);
        }
        const execute = () => this.commands.execute(who, cmd, () => {
            snapshot.checkReadBudget?.();
            const previewId = uuid(), p = { previewId, clientCommandId: input.clientCommandId, ...who, scope: clone(input.scopes), target: clone(input.target), rootRevision: snapshot.rootRevision, scanCompletedAt: snapshot.scanCompletedAt, ...(bound ? { scopeBindingProof: clone(bound.audit) } : {}), status: 'READY', totalFrozen: unique.size, cursorSecret: fingerprint([uuid(), uuid()]), manifestFingerprint: '0'.repeat(64) };
            const rows = [...unique.values()].map((r, ordinal) => ({ ...r, previewId, ordinal, target: clone(input.target), ...(input.categoryOverride || {}), included: true, groupVersion: 0, confirmationVersion: null, representativeAssetId: null, representativeFingerprint: null, eligibilitySnapshot: null, sourceValid: true }));
            const groups = new Map();
            for (const r of rows) {
                const k = groupKey(r);
                if (!groups.has(k))
                    groups.set(k, []);
                groups.get(k).push(r);
            }
            for (const group of groups.values()) {
                if (!group[0].sha256)
                    continue;
                const equivalent = new Set(group.map(metadataFingerprint)).size === 1;
                if (equivalent) {
                    const rep = group[0].assetId, F = groupFingerprint(previewId, group[0].sha256, group, rep);
                    for (const r of group)
                        Object.assign(r, { representativeAssetId: rep, representativeFingerprint: F, confirmationVersion: 0 });
                }
            }
            p.manifestFingerprint = this.manifest(p, rows);
            const saved = this.store.insert('cloud_upload_previews', p);
            for (const r of rows)
                this.store.insert(T, r);
            return this.view(saved);
        });
        return bound ? this.store.transaction(() => { bound.check(); const result = execute(); snapshot.checkReadBudget(); this.guard(who); return result; }) : execute();
        } finally { bound?.release(); }
    }
    group(who, previewId, sha256, representativeAssetId = null) { const p = this.owned(who, previewId), rows = this.rows(p.previewId).filter(r => r.sha256 === sha256); if (!rows.length)
        fail('NOT_FOUND', 404); const rep = representativeAssetId || rows[0].representativeAssetId; return { sha256, groupVersion: rows[0].groupVersion, confirmationVersion: rows[0].confirmationVersion, representativeAssetId: rep, fingerprint: rep ? groupFingerprint(p.previewId, sha256, rows, rep) : null }; }
    selection(who, previewId, input) {
        this.guard(who);
        body(input);
        exact(input, ['clientCommandId', 'expectedVersion', 'changes', 'representatives']);
        id(input.clientCommandId);
        integer(input.expectedVersion);
        const changes = input.changes || [], reps = input.representatives || [];
        if (!Array.isArray(changes) || !Array.isArray(reps) || changes.length > 100 || reps.length > 100)
            fail('INVALID_REQUEST', 400);
        const changedIds = new Set();
        for (const change of changes) {
            if (changedIds.has(change.assetId))
                fail('INVALID_REQUEST', 400);
            changedIds.add(change.assetId);
            exact(change, ['assetId', 'included']);
            id(change.assetId);
            if (typeof change.included !== 'boolean')
                fail('INVALID_REQUEST', 400);
        }
        for (const rep of reps) {
            exact(rep, ['sha256', 'representativeAssetId', 'expectedGroupVersion', 'confirmedFingerprint']);
            hash(rep.sha256);
            id(rep.representativeAssetId);
            integer(rep.expectedGroupVersion);
            hash(rep.confirmedFingerprint);
        }
        const cmd = { clientCommandId: input.clientCommandId, targetKind: 'preview', targetId: previewId, action: 'selection', expectedVersion: input.expectedVersion, payload: input };
        return this.commands.execute(who, cmd, () => {
            const p = this.owned(who, previewId);
            if (p.version !== input.expectedVersion)
                fail('PREVIEW_STALE');
            const rows = this.rows(previewId), affected = new Set();
            for (const change of changes) {
                const r = rows.find(r => r.assetId === change.assetId);
                if (!r)
                    fail('INVALID_REQUEST', 400);
                if (r.included !== change.included) {
                    affected.add(groupKey(r));
                    r.included = change.included;
                }
            }
            const seen = new Set();
            for (const rep of reps) {
                if (seen.has(rep.sha256))
                    fail('INVALID_REQUEST', 400);
                seen.add(rep.sha256);
                const group = rows.filter(r => r.sha256 === rep.sha256);
                if (!group.length || group[0].groupVersion !== rep.expectedGroupVersion)
                    fail('VERSION_CONFLICT');
                if (group[0].representativeAssetId !== rep.representativeAssetId)
                    affected.add(rep.sha256);
            }
            for (const key of new Set([...affected, ...reps.map(r => r.sha256)])) {
                const group = rows.filter(r => groupKey(r) === key), proof = reps.find(r => r.sha256 === key), version = group[0].groupVersion + (affected.has(key) ? 1 : 0);
                for (const r of group)
                    Object.assign(r, { groupVersion: version, confirmationVersion: affected.has(key) ? null : r.confirmationVersion, representativeFingerprint: affected.has(key) ? null : r.representativeFingerprint });
                if (proof) {
                    const F = groupFingerprint(previewId, key, group, proof.representativeAssetId);
                    if (F !== proof.confirmedFingerprint)
                        fail('REPRESENTATIVE_STALE');
                    for (const r of group)
                        Object.assign(r, { representativeAssetId: proof.representativeAssetId, representativeFingerprint: F, confirmationVersion: version });
                }
            }
            for (const row of rows) {
                const old = this.store.get(T, { previewId, ordinal: row.ordinal });
                if (canonical({ ...old, updatedAt: 0 }) !== canonical({ ...row, updatedAt: 0 }))
                    this.store.update(T, old, row);
            }
            const saved = this.store.update('cloud_upload_previews', p, { manifestFingerprint: this.manifest(p, rows) });
            return this.view(saved);
        });
    }
    // Trusted source reconciliation, not a browser arbitrary-path/edit API.
    revise(who, previewId, expectedVersion, assetId, patch) { this.guard(who); exact(patch, ['sourceVersion', 'sha256', 'fileName', 'mediaKind', 'category', 'subcategory', 'target', 'declaredBytes']); return this.store.transaction(() => { const p = this.owned(who, previewId); if (p.version !== expectedVersion)
        fail('PREVIEW_STALE'); const rows = this.rows(previewId), r = rows.find(r => r.assetId === assetId); if (!r)
        fail('NOT_FOUND', 404); const oldKey = groupKey(r); const next = asset(Object.fromEntries(['assetId', 'rootId', 'sourceVersion', 'mediaKind', 'fileName', 'category', 'subcategory', 'target', 'sha256', 'declaredBytes'].map(k => [k, Object.hasOwn(patch, k) ? patch[k] : r[k]]))); if (canonical(next) === canonical(Object.fromEntries(Object.keys(next).map(k => [k, r[k]]))))
        return this.view(p); Object.assign(r, next); const keys = new Set([oldKey, groupKey(r)]); for (const key of keys) {
        const group = rows.filter(x => groupKey(x) === key);
        const version = Math.max(0, ...group.map(x => x.groupVersion)) + 1;
        for (const row of group)
            Object.assign(row, { groupVersion: version, confirmationVersion: null, representativeFingerprint: null, sourceValid: true });
    } for (const row of rows) {
        const old = this.store.get(T, { previewId, ordinal: row.ordinal });
        if (canonical(row) !== canonical(old))
            this.store.update(T, old, row);
    } return this.view(this.store.update('cloud_upload_previews', p, { manifestFingerprint: this.manifest(p, rows) })); }); }
    cacheEligibility(who, sha256, source, projection) { this.guard(who); hash(sha256); sourceVersion(source); if (!['NEW', 'IN_PROGRESS', 'UPLOADED', 'HISTORICAL', 'NEEDS_RECONCILIATION'].includes(projection.classification))
        fail('INVALID_REQUEST', 400); integer(projection.serverStateVersion); integer(projection.admissionEpoch); const key = { ...namespace(who), sha256 }; return this.store.transaction(() => { const old = this.store.get('cloud_upload_eligibility_cache', key), r = { ...key, verifiedSourceVersion: clone(source), serverStateVersion: projection.serverStateVersion, admissionEpoch: projection.admissionEpoch, generation: projection.generation ?? null, checkedAt: this.store.clock(), projection: { classification: projection.classification } }; return old ? this.store.update('cloud_upload_eligibility_cache', old, r) : this.store.insert('cloud_upload_eligibility_cache', r); }); }
    page(who, previewId, { cursor: token = null, limit = 100, filter = 'pending', scanBudget = 500 } = {}) { const p = this.owned(who, previewId); integer(limit, 1, 100); integer(scanBudget, 1, 500); if (!['all', 'pending'].includes(filter))
        fail('INVALID_REQUEST', 400); const filterFingerprint = fingerprint({ filter }), binding = { previewId, version: p.version, identity: fingerprint(who), filterFingerprint }; const after = token === null ? -1 : readCursor(p.cursorSecret, token, binding), raw = this.store.list(T, { previewId }, { after, limit: scanBudget, order: 'ordinal' }); const items = [], excludedCounts = { uploaded: 0, excluded: 0 }; let scanned = 0, last = after; for (const row of raw) {
        scanned++;
        last = row.ordinal;
        const cache = row.sha256 ? this.store.get('cloud_upload_eligibility_cache', { ...namespace(who), sha256: row.sha256 }) : null;
        const fresh = cache && this.store.clock() >= cache.checkedAt && this.store.clock() - cache.checkedAt <= 30000 && canonical(cache.verifiedSourceVersion) === canonical(row.sourceVersion);
        row.classification = fresh ? cache.projection.classification : 'UNKNOWN';
        if (!row.included) {
            excludedCounts.excluded++;
            continue;
        }
        if (filter === 'pending' && row.classification === 'UPLOADED') {
            excludedCounts.uploaded++;
            continue;
        }
        items.push(publicItem(row));
        if (items.length >= limit)
            break;
    } const scanComplete = last >= p.totalFrozen - 1; return { previewId, version: p.version, filterFingerprint, items, lastScannedOrdinal: last, nextCursor: scanComplete ? null : cursor(p.cursorSecret, { ...binding, lastOrdinal: last }), scanComplete, scanned, totalFrozen: p.totalFrozen, excludedCounts }; }
}
// Optional production-library adapter: caller must supply the real scan readiness/revision reader.
// It never invents a completed scan and never copies payload or receives a browser path.
export function libraryScopeSnapshot(lib, upload, readScanState, {maxBytes=PREVIEW_READ_LIMITS.maxBytes,timeoutMs=PREVIEW_READ_LIMITS.timeoutMs,now=()=>performance.now()}={}) {
    if (typeof readScanState !== 'function')
        fail('SCOPE_NOT_READY');
    integer(maxBytes,0,PREVIEW_READ_LIMITS.maxBytes);integer(timeoutMs,0,PREVIEW_READ_LIMITS.timeoutMs);if(typeof now!=='function')fail('INVALID_REQUEST',400);
    return async (who, input, {budget=createPreviewReadBudget({maxBytes,timeoutMs,now}),signal}={}) => {
        if(!isPreviewReadBudget(budget)||budget.state().maxBytes>maxBytes||budget.state().timeoutMs>timeoutMs||signal!==undefined&&!(signal instanceof AbortSignal))fail('INVALID_REQUEST',400);
        const check=()=>{if(signal?.aborted)fail('PREVIEW_CANCELLED',409);budget.check();};
        const ready=value=>plainScan(value)&&value.scanComplete===true&&value.offline===false&&Number.isSafeInteger(value.rootRevision)&&value.rootRevision>=0&&Number.isSafeInteger(value.scanCompletedAt)&&value.scanCompletedAt>0;
        check();const before = await readScanState(clone(input.scopes));check();
        if (!ready(before))
            fail('SCOPE_NOT_READY');
        const selected = new Map();
        for (const scope of input.scopes) {
            check();const root = lib.rootById(scope.rootId);
            if (!root || root.retired || root.online === 0)
                fail('SCOPE_NOT_READY');
            const where = ['root_id = ?', "kind IN ('music','sfx')", 'trashed = 0', 'online = 1', lib.nonMissingAssetScope()], params = [scope.rootId];
            if (scope.category !== null) {
                where.push('category = ?');
                params.push(scope.category);
            }
            if (scope.subcategory !== null) {
                where.push('sub = ?');
                params.push(scope.subcategory);
            }
            const rows = lib.db.prepare(`SELECT id FROM assets WHERE ${where.join(' AND ')} ORDER BY id LIMIT 5001`).all(...params);check();
            for (const r of rows)
                selected.set(r.id, r.id);
            if (selected.size > 5000)
                fail('ITEM_LIMIT', 413);
        }
        const items = [];
        for (const assetId of [...selected.keys()].sort()){
            check();const inspected=await upload.inspectForBatch(assetId,{budget,signal});check();items.push({ ...inspected, target: clone(input.target) });
        }
        check();const after = await readScanState(clone(input.scopes));check();
        if (!ready(after) || after.rootRevision !== before.rootRevision || after.scanCompletedAt !== before.scanCompletedAt)
            fail('SCOPE_CHANGED');
        return { ...before, items, checkReadBudget:check };
    };
}
const plainScan=value=>value&&typeof value==='object'&&!Array.isArray(value);

