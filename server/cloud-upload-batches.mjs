import { CloudUploadCommands } from './cloud-upload-commands.mjs';
import { LIMITS, identity, namespace, sameIdentity, body, exact, id, uuid, integer, clone, canonical, fingerprint, groupKey, groupFingerprint, metadata, metadataFingerprint, authoritativeReceipt, availabilityProjection, receiptFacts, SCHEDULER_LIMITS, requestObservation, terminationEvidence, fail } from './cloud-upload-protocol.mjs';
const terminal = new Set(['COMMITTED', 'SKIPPED', 'FAILED', 'CANCELLED']);
export class CloudUploadBatches {
    constructor(store, preview, { upload, currentIdentity, authorize = async () => ({ canCreateUploads: false }), hook = () => { } } = {}) { this.store = store; this.preview = preview; this.upload = upload; this.currentIdentity = currentIdentity || preview.currentIdentity; this.authorize = authorize; this.hook = hook; this.commands = new CloudUploadCommands(store); }
    guard(who) { identity(who); if (!sameIdentity(who, identity(this.currentIdentity())))
        fail('AUTH_CHANGED'); }
    owned(who, batchId) { this.guard(who); const b = this.store.get('cloud_upload_batches', { batchId: id(batchId), ...namespace(who) }); if (!b || !sameIdentity(b, who, false))
        fail('NOT_FOUND', 404); return b; }
    item(who, itemId) { const r = this.store.get('cloud_upload_batch_items', { itemId: id(itemId) }); if (!r)
        fail('NOT_FOUND', 404); const b = this.owned(who, r.batchId); return { r, b }; }
    rows(batchId) { return this.store.list('cloud_upload_batch_items', { batchId }, { order: 'ordinal' }); }
    view(b) { return { batchId: b.batchId, version: b.version, state: b.state, totalItems: b.totalItems, stopRequested: b.stopRequested }; }
    create(who, input) {
        this.guard(who);
        body(input);
        exact(input, ['clientCommandId', 'previewId', 'expectedPreviewVersion', 'manifestFingerprint', 'startPaused', 'representativeConfirmations']);
        id(input.clientCommandId);
        id(input.previewId);
        integer(input.expectedPreviewVersion);
        if (input.startPaused !== false && input.startPaused !== true)
            fail('INVALID_REQUEST', 400);
        const references = input.representativeConfirmations || [];
        if (!Array.isArray(references) || references.length > 100)
            fail('BODY_LIMIT', 413);
        const cmd = { clientCommandId: input.clientCommandId, targetKind: 'batch', targetId: input.previewId, action: 'create', expectedVersion: input.expectedPreviewVersion, payload: input };
        return this.commands.execute(who, cmd, () => {
            const p = this.preview.owned(who, input.previewId);
            if (p.version !== input.expectedPreviewVersion || p.manifestFingerprint !== input.manifestFingerprint || p.status !== 'READY')
                fail('PREVIEW_STALE');
            const all = this.preview.rows(p.previewId), groups = new Map();
            for (const r of all.filter(r => r.included)) {
                const key = groupKey(r);
                if (!groups.has(key))
                    groups.set(key, []);
                groups.get(key).push(r);
            }
            for (const ref of references) {
                exact(ref, ['sha256', 'groupVersion', 'fingerprint']);
                const group = groups.get(ref.sha256);
                if (!group || group[0].groupVersion !== ref.groupVersion || group[0].representativeFingerprint !== ref.fingerprint)
                    fail('REPRESENTATIVE_STALE');
            }
            const batchId = uuid(), b = this.store.insert('cloud_upload_batches', { batchId, clientCommandId: input.clientCommandId, payloadFingerprint: fingerprint(input), previewId: p.previewId, previewVersion: p.version, manifestFingerprint: p.manifestFingerprint, ...who, state: input.startPaused ? 'PAUSED' : 'QUEUED', stopRequested: false, totalItems: groups.size });
            let ordinal = 0;
            for (const group of groups.values()) {
                const first = group[0], rep = group.find(r => r.assetId === first.representativeAssetId), valid = !!first.sha256 && !!rep && group.every(r => r.groupVersion === first.groupVersion && r.confirmationVersion === r.groupVersion && r.sourceValid) && first.representativeFingerprint === groupFingerprint(p.previewId, first.sha256, group, rep.assetId), unknown = !first.sha256;
                const chosen = valid ? rep : unknown && group.length === 1 ? first : null;
                this.store.insert('cloud_upload_batch_items', { itemId: uuid(), batchId, ordinal: ordinal++, representativeAssetId: chosen?.assetId ?? null, assetId: chosen?.assetId ?? null, sourceVersion: chosen?.sourceVersion ?? null, metadata: chosen ? metadata(chosen) : null, metadataFingerprint: chosen ? metadataFingerprint(chosen) : fingerprint(group.map(r => ({ assetId: r.assetId, sourceVersion: r.sourceVersion }))), target: chosen?.target ?? null, state: valid ? 'QUEUED' : 'NEEDS_CONFIRMATION', resultMode: null, sha256: first.sha256, declaredBytes: first.declaredBytes, currentAttemptId: null, intentId: null, clientRequestId: null, serverRequestId: null, receipt: null, lastCode: null, retryCount: 0, nextRetryAt: null, groupVersion: first.groupVersion, representativeFingerprint: valid ? first.representativeFingerprint : null, cleanupPending: false });
            }
            return this.view(b);
        });
    }
    page(who, batchId, { after = -1, limit = 100 } = {}) { const b = this.owned(who, batchId); integer(after, -1); integer(limit, 1, 100); const rows = this.store.list('cloud_upload_batch_items', { batchId }, { after, limit, order: 'ordinal' }); return { batch: this.view(b), items: rows.map(r => ({ itemId: r.itemId, ordinal: r.ordinal, assetId: r.representativeAssetId, state: r.state, resultMode: r.resultMode, receipt: r.receipt ? clone(r.receipt) : null, currentAvailability: r.currentAvailability ? clone(r.currentAvailability) : null, lastCode: r.lastCode, resourcesRetained: r.resourcesRetained === true, retainedReason: r.retainedReason ?? null, version: r.version })), nextOrdinal: rows.at(-1)?.ordinal ?? after, complete: (rows.at(-1)?.ordinal ?? after) >= b.totalItems - 1 }; }
    beginAttempt(who, itemId) {
        this.guard(who);
        return this.store.transaction(() => {
            let { r, b } = this.item(who, itemId);
            if (b.stopRequested || b.state === 'PAUSED')
                fail('BATCH_PAUSED');
            if (b.epoch !== who.epoch)
                fail('AUTH_CHANGED');
            if (!r.receipt && terminal.has(r.state) && !r.retryAuthorized) fail('ITEM_TERMINAL'); if (r.receipt)
                return { item: r, attempt: this.store.get('cloud_upload_item_attempts', { attemptId: r.currentAttemptId }) };
            if (!r.sha256 || !r.representativeAssetId || !r.representativeFingerprint)
                fail(r.sha256 ? 'NEEDS_CONFIRMATION' : 'HASH_REQUIRED');
            const group = this.preview.rows(b.previewId).filter(x => x.sha256 === r.sha256 && x.included);
            if (!group.length || group[0].groupVersion !== r.groupVersion || group[0].confirmationVersion !== r.groupVersion || groupFingerprint(b.previewId, r.sha256, group, r.representativeAssetId) !== r.representativeFingerprint)
                fail('REPRESENTATIVE_STALE');
            if(r.currentAttemptId&&r.retryAuthorized&&(r.cleanupPending||r.resourcesRetained))fail('CLEANUP_PENDING');
            if (r.currentAttemptId && !r.retryAuthorized)
                return { item: r, attempt: this.store.get('cloud_upload_item_attempts', { attemptId: r.currentAttemptId }) };
            const attemptNo = r.currentAttemptId ? this.store.get('cloud_upload_item_attempts', { attemptId: r.currentAttemptId }).attemptNo + 1 : 1, attemptId = uuid(), intentId = uuid(), clientRequestId = uuid(), claimKey = fingerprint({ ...namespace(who), assetId: r.representativeAssetId, sourceVersion: r.sourceVersion, target: r.target, metadataFingerprint: r.metadataFingerprint }), old = this.store.get('cloud_upload_active_claims', { claimKey });
            if (old && old.itemId !== itemId)
                fail('ACTIVE_ITEM_EXISTS');
            if (old)
                this.store.removeClaim(old);
            const attempt = this.store.insert('cloud_upload_item_attempts', { attemptId, itemId, ...namespace(who), attemptNo, intentId, clientRequestId, metadataFingerprint: r.metadataFingerprint, sourceVersion: r.sourceVersion, serverRequestId: null, serverAttemptId: null, state: 'RESERVED', receiptId: null });
            this.store.insert('cloud_upload_active_claims', { claimKey, itemId, ...namespace(who), assetId: r.representativeAssetId, sourceVersion: r.sourceVersion, target: r.target, metadataFingerprint: r.metadataFingerprint, attemptId });
            r = this.store.update('cloud_upload_batch_items', r, { currentAttemptId: attemptId, intentId, clientRequestId, serverRequestId:null, requestState:null, state: 'PREPARING', retryAuthorized: false, safeTerminal:false, retryCount:0, nextRetryAt:null, schedulerBlocked:false });
            return { item: r, attempt };
        });
    }
    async prepareItem(who, itemId, {expectedBatchVersion=null}={}) {
        this.guard(who);
        if(expectedBatchVersion!==null&&this.item(who,itemId).b.version!==expectedBatchVersion)fail('VERSION_CONFLICT');
        const saved = this.beginAttempt(who, itemId);
        this.hook('after-attempt-db');
        if (saved.item.receipt)
            return saved.item;
        const eligibility = await this.authorize(clone(who), clone(saved.item));
        this.guard(who);
        if (eligibility.canCreateUploads !== true)
            fail('PROTOCOL_UPDATE_REQUIRED', 503);
        if (eligibility.classification !== 'NEW' && eligibility.classification !== 'IN_PROGRESS')
            fail('NEEDS_RECONCILIATION');
        const currentPreparation=this.item(who,itemId);
        if(currentPreparation.b.stopRequested||currentPreparation.b.state==='PAUSED')fail('BATCH_PAUSED');
        if(expectedBatchVersion!==null&&currentPreparation.b.version!==expectedBatchVersion)fail('VERSION_CONFLICT');
        const { item: r, attempt } = saved;
        const intent = await this.upload.prepareWithIdentity({ intentId: attempt.intentId, clientRequestId: attempt.clientRequestId }, r.sourceVersion, { assetId: r.representativeAssetId, sha256: r.sha256, ...r.metadata });
        this.guard(who);
        if (typeof this.upload.bindSettledContext === 'function') {
            await this.upload.bindSettledContext({intentId:attempt.intentId,clientRequestId:attempt.clientRequestId}, {identity:clone(who),batchId:r.batchId,itemId:r.itemId,localAttemptId:attempt.attemptId,metadataFingerprint:r.metadataFingerprint});
            this.guard(who);
        }
        this.hook('after-intent-durable');
        return this.store.transaction(() => { const current = this.item(who, itemId).r; if (current.currentAttemptId !== attempt.attemptId)
            fail('STALE_ATTEMPT'); const b = this.owned(who, current.batchId); if (b.stopRequested || b.state === 'PAUSED')
            return current; this.store.update('cloud_upload_item_attempts', this.store.get('cloud_upload_item_attempts', { attemptId: attempt.attemptId }), { state: 'PREPARED' }); return this.store.update('cloud_upload_batch_items', current, { state: intent.state === 'unknown' ? 'RECONCILING' : 'HASHED', lastCode: intent.state === 'unknown' ? 'UPLOAD_UNKNOWN' : null }); });
    }
    async recordReceipt(capturedIdentity, itemId, attemptId, raw) {
        identity(capturedIdentity);
        let saved;
        this.store.transaction(() => { const r = this.store.get('cloud_upload_batch_items', { itemId: id(itemId) }); if (!r)
            fail('NOT_FOUND', 404); const b = this.store.get('cloud_upload_batches', { batchId: r.batchId, ...namespace(capturedIdentity) }); if (!b || !sameIdentity(b, capturedIdentity, false))
            fail('NOT_FOUND', 404); const attempt = this.store.get('cloud_upload_item_attempts', { attemptId: id(attemptId), itemId, ...namespace(capturedIdentity) }); if (!attempt || r.currentAttemptId !== attemptId)
            fail('STALE_ATTEMPT'); const receipt = authoritativeReceipt(raw, attempt, r), currentAvailability = availabilityProjection(raw.currentAvailability); if (r.receipt && canonical(receiptFacts(r.receipt)) !== canonical(receipt))
            fail('RECEIPT_CONFLICT'); if (r.receipt) {
            saved = canonical(r.currentAvailability) === canonical(currentAvailability) ? r : this.store.update('cloud_upload_batch_items', r, { currentAvailability });
            return;
        } if (attempt.serverRequestId && attempt.serverRequestId !== receipt.canonicalRequestId)
            fail('RECEIPT_CONFLICT'); this.store.update('cloud_upload_item_attempts', attempt, { state: 'COMMITTED', pendingReservation:false, receiptId: receipt.receiptId, serverRequestId: receipt.canonicalRequestId, serverAttemptId: receipt.attemptId }); saved = this.store.update('cloud_upload_batch_items', r, { state: 'COMMITTED', receipt, currentAvailability, resultMode: receipt.mode, serverRequestId: receipt.canonicalRequestId, cleanupPending: true, resourcesRetained:false, retainedReason:null, retryCount:0, nextRetryAt:null, schedulerBlocked:false, lastCode: null }); const claim = this.store.list('cloud_upload_active_claims', { itemId }, { limit: 1 })[0]; if (claim)
            this.store.removeClaim(claim); this.settle(b); });
        this.hook('after-receipt-db');
        // A late authenticated callback may preserve its own historical receipt; never clean a new identity's module.
        if (!sameIdentity(capturedIdentity, identity(this.currentIdentity())))
            return { recorded: true, cleanupPending: true };
        try {
            await this.upload.forgetVerified({ intentId: saved.intentId, clientRequestId: saved.clientRequestId }, saved.receipt, () => { const current = this.store.get('cloud_upload_batch_items', { itemId: saved.itemId }); return current?.receipt ? clone(current.receipt) : null; });
            this.hook('after-forget');
            this.store.transaction(() => { const current = this.item(capturedIdentity, itemId).r; if (current.receipt?.receiptId === saved.receipt.receiptId)
                this.store.update('cloud_upload_batch_items', current, { cleanupPending: false, retryCount: 0, nextRetryAt: null, lastCode: null, schedulerBlocked: false }); });
        }
        catch (error) {
            if (error?.code === 'CRASH_TEST')
                throw error;
            return { recorded: true, cleanupPending: true };
        }
        return { recorded: true, cleanupPending: false };
    }
    command(who, batchId, input) { this.guard(who); exact(input, ['clientCommandId', 'expectedVersion', 'action']); if (!['pause', 'resume', 'stop', 'retry-failed'].includes(input.action))
        fail('INVALID_REQUEST', 400); const cmd = { clientCommandId: input.clientCommandId, targetKind: 'batch', targetId: batchId, action: input.action, expectedVersion: input.expectedVersion, payload: input }; return this.commands.execute(who, cmd, () => { const b = this.owned(who, batchId); if (b.version !== input.expectedVersion)
        fail('VERSION_CONFLICT'); if (b.stopRequested && input.action !== 'stop') fail('BATCH_STOPPING'); if (['COMPLETED', 'STOPPED'].includes(b.state) || (b.state === 'COMPLETED_WITH_ISSUES' && input.action !== 'retry-failed'))
        return this.view(b); let patch = {}; if (input.action === 'pause')
        patch = { state: 'PAUSED' }; if (input.action === 'resume') {
        if (b.stopRequested)
            fail('BATCH_STOPPING');
        for (const row of this.rows(batchId)) if (!row.receipt && row.schedulerBlocked && ['RECONCILING','RETRY_WAIT'].includes(row.state)) this.store.update('cloud_upload_batch_items',row,{schedulerBlocked:false,retryCount:0,nextRetryAt:null});
        patch = { state: 'QUEUED', epoch: who.epoch };
    } if (input.action === 'stop') {
        patch = { state: 'STOPPING', stopRequested: true };
        for (const row of this.rows(batchId))
            if (!row.currentAttemptId && !terminal.has(row.state))
                this.store.update('cloud_upload_batch_items', row, { state: 'CANCELLED' });
            else if (row.currentAttemptId && !terminal.has(row.state))
                this.store.update('cloud_upload_batch_items',row,{state:'RECONCILING',schedulerBlocked:false,retryCount:0,nextRetryAt:null});
    } if (input.action === 'retry-failed') {
        for (const row of this.rows(batchId).filter(r => r.state === 'FAILED')) {
            const attempt = row.currentAttemptId ? this.store.get('cloud_upload_item_attempts', { attemptId: row.currentAttemptId }) : null;
            if (!attempt || attempt.state !== 'FAILED_FENCED' || !row.safeTerminal)
                fail('NEEDS_RECONCILIATION');
            this.store.update('cloud_upload_batch_items', row, { state: 'QUEUED', retryAuthorized: true, safeTerminal: false });
        }
        patch = { state: 'QUEUED', epoch: who.epoch };
    } const updated = this.store.update('cloud_upload_batches', b, patch); return this.view(this.settle(updated)); }); }
    terminalAttempt(who, itemId, attemptId, proof) { this.guard(who); if (proof?.commitState !== 'NOT_COMMITTED' || proof.workerSettled !== true || proof.operationsSettled !== true)
        fail('NEEDS_RECONCILIATION'); return this.store.transaction(() => { const { r, b } = this.item(who, itemId); if (r.currentAttemptId !== attemptId || r.receipt)
        fail('STALE_ATTEMPT'); const a = this.store.get('cloud_upload_item_attempts', { attemptId }); this.store.update('cloud_upload_item_attempts', a, { state: 'FAILED_FENCED' }); const claim = this.store.list('cloud_upload_active_claims', { itemId }, { limit: 1 })[0]; if (claim)
        this.store.removeClaim(claim); const saved = this.store.update('cloud_upload_batch_items', r, { state: 'FAILED', safeTerminal: true, lastCode: 'NOT_COMMITTED' }); this.settle(b); return saved; }); }
    recover(who) {
        this.guard(who);
        let count = 0, after = null;
        for (;;) {
            // Stable PK keyset pages include all history without retaining it or raising LIMIT.
            const page = this.store.list('cloud_upload_batches', namespace(who), { after, limit: 100, order: 'batchId' });
            if (!page.length) break;
            for (const observed of page) {
                if (!sameIdentity(observed, who, false) || ['COMPLETED', 'COMPLETED_WITH_ISSUES', 'STOPPED'].includes(observed.state)) continue;
                this.store.transaction(() => {
                    this.guard(who);
                    const b = this.owned(who, observed.batchId);
                    if (['COMPLETED', 'COMPLETED_WITH_ISSUES', 'STOPPED'].includes(b.state)) return;
                    for (const r of this.rows(b.batchId)) {
                        if (r.currentAttemptId && !terminal.has(r.state)) this.store.update('cloud_upload_batch_items', r, { state: 'RECONCILING' });
                    }
                    this.store.update('cloud_upload_batches', b, { state: b.stopRequested ? 'STOPPING' : 'PAUSED' });
                    count++;
                });
            }
            after = page.at(-1).batchId;
            if (page.length < 100) break;
        }
        return { recovered: count };
    }
    // Scheduler domain seam: bounded store reads, no new schema or bypass SQL.
    schedulerBatches(who, after = null) {
        this.guard(who);
        return this.store.list('cloud_upload_batches', namespace(who), {after, limit: 1, order: 'batchId'});
    }
    schedulerItems(who, batchId) {
        return this.store.transaction(() => {
            let batch = this.owned(who, batchId), after = batch.schedulerCursor ?? -1;
            let items = this.store.list('cloud_upload_batch_items', {batchId}, {after, limit: 100, order: 'ordinal'});
            if (!items.length && after !== -1) items = this.store.list('cloud_upload_batch_items', {batchId}, {limit: 100, order: 'ordinal'});
            const next = items.length === 100 ? items.at(-1).ordinal : -1;
            if (next !== after) batch = this.store.update('cloud_upload_batches', batch, {schedulerCursor: next});
            return {batch, items};
        });
    }
    schedulerContext(who, itemId, {dispatch = false} = {}) {
        const {r: item, b: batch} = this.item(who, itemId);
        const attempt = item.currentAttemptId ? this.store.get('cloud_upload_item_attempts', {attemptId: item.currentAttemptId, itemId, ...namespace(who)}) : null;
        if (dispatch) {
            if (batch.stopRequested || batch.state === 'PAUSED') fail('BATCH_PAUSED');
            if (batch.epoch !== who.epoch) fail('AUTH_CHANGED');
            if (item.receipt || terminal.has(item.state)) fail('ITEM_TERMINAL');
            if (item.retryAuthorized || (attempt && attempt.attemptNo > 1 && !(attempt.retryClaim?.confirmed===true&&attempt.retryClaim.recorded===true))) fail('RETRY_CLAIM_REQUIRED', 503);
            const group = this.store.list('cloud_upload_preview_items',{previewId:batch.previewId,sha256:item.sha256},{limit:5001,order:'ordinal'}).filter(r=>r.included);
            if (!item.sha256 || !item.representativeAssetId || !item.representativeFingerprint || !group.length ||
                group.some(r => !r.sourceValid || r.groupVersion !== item.groupVersion || r.confirmationVersion !== item.groupVersion) ||
                groupFingerprint(batch.previewId, item.sha256, group, item.representativeAssetId) !== item.representativeFingerprint) fail('REPRESENTATIVE_STALE');
        }
        if (item.currentAttemptId && !attempt) fail('STORE_INVALID');
        return {item, batch, attempt};
    }
    schedulerUpdate(who, context, patch, {dispatch = false} = {}) {
        exact(patch, ['state','lastCode','nextRetryAt','retryCount','schedulerBlocked','intentPrepared','reuseDecision']);
        if (patch.state !== undefined && !['HASHED','REQUESTING','WAITING_APPROVAL','READY','CHECKING_REUSE','UPLOADING','RECONCILING','RETRY_WAIT','NEEDS_CONFIRMATION'].includes(patch.state)) fail('INVALID_REQUEST');
        if (patch.lastCode !== undefined && patch.lastCode !== null && !/^[A-Z][A-Z0-9_]{0,63}$/.test(patch.lastCode)) fail('INVALID_REQUEST');
        if (patch.nextRetryAt !== undefined && patch.nextRetryAt !== null) integer(patch.nextRetryAt);
        if (patch.retryCount !== undefined) integer(patch.retryCount, 0, SCHEDULER_LIMITS.retries);
        for (const k of ['schedulerBlocked','intentPrepared']) if (patch[k] !== undefined && typeof patch[k] !== 'boolean') fail('INVALID_REQUEST');
        if (patch.reuseDecision !== undefined && ![null,'NEEDS_UPLOAD'].includes(patch.reuseDecision)) fail('INVALID_REQUEST');
        return this.store.transaction(() => {
            const current = this.schedulerContext(who, context.item.itemId, {dispatch});
            if (current.item.version !== context.item.version || current.batch.version !== context.batch.version || current.item.currentAttemptId !== context.item.currentAttemptId) fail('VERSION_CONFLICT');
            if ((current.item.receipt || terminal.has(current.item.state)) && Object.keys(patch).some(k=>!['lastCode','nextRetryAt','retryCount','schedulerBlocked'].includes(k))) fail('ITEM_TERMINAL');
            const item = this.store.update('cloud_upload_batch_items', current.item, patch);
            let batch = current.batch;
            if (dispatch && batch.state !== 'RUNNING') batch = this.store.update('cloud_upload_batches', batch, {state: 'RUNNING'});
            return {item, batch, attempt: current.attempt};
        });
    }
    schedulerPending(who) {
        this.guard(who); let after = null, count = 0;
        for (;;) {
            // Includes uncertain requests reserved before their potentially PENDING response.
            const page=this.store.list('cloud_upload_item_attempts',{...namespace(who),state:'WAITING_APPROVAL'},{after,limit:100,order:'attemptId'});
            for(const attempt of page){
                const item=this.store.get('cloud_upload_batch_items',{itemId:attempt.itemId});
                if(!item||item.receipt||item.currentAttemptId!==attempt.attemptId)continue;
                const batch=this.store.get('cloud_upload_batches',{batchId:item.batchId,...namespace(who)});
                if(batch&&++count>=SCHEDULER_LIMITS.pending)return count;
            }
            if(page.length<100)return count;
            after=page.at(-1).attemptId;
        }
    }
    schedulerRequest(who, context, now, reviewRequired) {
        integer(now);if(typeof reviewRequired!=='boolean')fail('INVALID_REQUEST');
        return this.store.transaction(() => {
            const current = this.schedulerContext(who, context.item.itemId, {dispatch:true});
            if (current.item.version !== context.item.version || current.batch.version !== context.batch.version || !current.attempt) fail('VERSION_CONFLICT');
            if(reviewRequired&&this.schedulerPending(who)>=SCHEDULER_LIMITS.pending)fail('PENDING_WINDOW_FULL');
            // One bounded page; pressure beyond it fails closed rather than omitting requests.
            const recent = this.store.list('cloud_upload_item_attempts', namespace(who), {after:Math.max(-1,now-60000),limit:100,order:'updatedAt'});
            if (recent.length === 100) throw Object.assign(new Error('request window pressure'),{code:'LOCAL_REQUEST_RATE',retryAt:now+60000});
            const times = [];
            for (const a of recent) {
                if (a.updatedAt > now) fail('CLOCK_REGRESSION');
                const history = a.requestTimes ?? [];
                if (!Array.isArray(history) || history.length > 24) fail('STORE_INVALID');
                for (const at of history) {integer(at);if(at>now)fail('CLOCK_REGRESSION');if(at>now-60000)times.push(at);}
            }
            if (times.length >= 24) throw Object.assign(new Error('local request rate'),{code:'LOCAL_REQUEST_RATE',retryAt:Math.min(...times)+60001});
            const history = (current.attempt.requestTimes ?? []).filter(at=>at>now-60000);
            const attempt = this.store.update('cloud_upload_item_attempts', current.attempt, {requestTimes:[...history,now],state:reviewRequired?'WAITING_APPROVAL':'PREPARED',pendingReservation:reviewRequired});
            const item = this.store.update('cloud_upload_batch_items',current.item,{state:'REQUESTING',lastCode:null,nextRetryAt:null});
            const batch = current.batch.state==='RUNNING'?current.batch:this.store.update('cloud_upload_batches',current.batch,{state:'RUNNING'});
            return {item,batch,attempt};
        });
    }
    schedulerObserve(who, itemId, attemptId, raw, nextRetryAt) {
        integer(nextRetryAt);
        return this.store.transaction(() => {
            const c = this.schedulerContext(who,itemId);
            if (!c.attempt || c.attempt.attemptId !== attemptId || c.item.receipt || c.attempt.terminalEvidence || terminal.has(c.item.state)) fail('STALE_ATTEMPT');
            const observed = requestObservation(raw,c);
            const attempt = this.store.update('cloud_upload_item_attempts',c.attempt,{serverRequestId:observed.canonicalRequestId,serverAttemptId:observed.attemptId,remoteStateVersion:observed.stateVersion,remoteRequestState:observed.requestState,...(observed.requestVersion===undefined?{}:{remoteRequestVersion:observed.requestVersion,remoteQualificationVersion:observed.qualificationVersion}),admissionEpoch:observed.admissionEpoch,pendingReservation:observed.requestState==='PENDING',state:observed.requestState==='PENDING'?'WAITING_APPROVAL':observed.requestState==='APPROVED'?'READY':'RECONCILING'});
            const state = observed.requestState==='PENDING'?'WAITING_APPROVAL':observed.requestState==='APPROVED'?'READY':observed.requestState==='NOT_CREATED'?'HASHED':'NEEDS_CONFIRMATION';
            const item=this.store.update('cloud_upload_batch_items',c.item,{serverRequestId:observed.canonicalRequestId,state:c.batch.stopRequested?'RECONCILING':state,requestState:observed.requestState,remoteStateVersion:observed.stateVersion,retryCount:c.item.retryCount??0,lastCode:null,nextRetryAt:observed.requestState==='PENDING'?nextRetryAt:null});
            return {item,batch:c.batch,attempt};
        });
    }
    schedulerProject(who,batchId) {
        return this.store.transaction(()=>{
            const batch=this.owned(who,batchId);
            if(batch.stopRequested)return this.settle(batch);
            if(batch.state==='PAUSED')return batch;
            const pending=this.rows(batchId).filter(r=>!terminal.has(r.state));
            if(!pending.length)return this.settle(batch);
            let state='RUNNING';
            if(pending.every(r=>r.state==='WAITING_APPROVAL'))state='WAITING_APPROVAL';
            else if(pending.every(r=>r.schedulerBlocked||['NEEDS_CONFIRMATION','WAITING_APPROVAL'].includes(r.state)))state='NEEDS_ATTENTION';
            return state===batch.state?batch:this.store.update('cloud_upload_batches',batch,{state});
        });
    }
    schedulerTerminate(who, context, evidence, localExit) {
        exact(localExit,['operationId','kind','settledAt','itemId','localAttemptId','clientRequestId','identityFingerprint']);id(localExit.operationId);integer(localExit.settledAt);
        if (!['cancel','resolve'].includes(localExit.kind)) fail('NEEDS_RECONCILIATION');
        return this.store.transaction(() => {
            const current=this.schedulerContext(who,context.item.itemId);
            if (!current.attempt || current.attempt.attemptId!==context.attempt.attemptId || current.item.receipt) fail('STALE_ATTEMPT');
            if(localExit.itemId!==current.item.itemId||localExit.localAttemptId!==current.attempt.attemptId||localExit.clientRequestId!==current.item.clientRequestId||localExit.identityFingerprint!==fingerprint(who))fail('NEEDS_RECONCILIATION');
            const proof=terminationEvidence(evidence,who,current);
            if(current.attempt.terminalEvidence){
                if(canonical(current.attempt.terminalEvidence)!==canonical(proof))fail('TERMINAL_EVIDENCE_CONFLICT');
                return {item:current.item,proofId:proof.proofId,intentRetained:true};
            }
            this.store.update('cloud_upload_item_attempts',current.attempt,{state:'FAILED_FENCED',pendingReservation:false,terminalEvidence:proof,localExit:clone(localExit)});
            const claim=this.store.list('cloud_upload_active_claims',{itemId:current.item.itemId},{limit:1})[0];if(claim)this.store.removeClaim(claim);
            const item=this.store.update('cloud_upload_batch_items',current.item,{state:'FAILED',safeTerminal:true,lastCode:'NOT_COMMITTED',cleanupPending:true,retryCount:0,nextRetryAt:null,schedulerBlocked:false,resourcesRetained:true,retainedReason:'NON_SUCCESS_INTENT_RETAINED'});
            this.settle(current.batch);
            return {item,proofId:proof.proofId,intentRetained:true};
        });
    }
    // Explicit confirmed command only. All generated identities/body commit before any HTTP.
    async retryHttp(who,itemId,input,remote) {
        this.guard(who);exact(input,['clientCommandId','expectedVersion','qualificationVersion','confirmed']);id(input.clientCommandId);integer(input.expectedVersion);integer(input.qualificationVersion);if(input.confirmed!==true||typeof remote?.retryClaim!=='function')fail('RETRY_CLAIM_REQUIRED');
        const cmd={clientCommandId:input.clientCommandId,targetKind:'item',targetId:id(itemId),action:'retry-http',expectedVersion:input.expectedVersion,payload:clone(input)};
        const saved=this.commands.execute(who,cmd,()=>{
            const c=this.schedulerContext(who,itemId),r=c.item,a=c.attempt;
            if(c.batch.epoch!==who.epoch||c.batch.stopRequested||r.version!==input.expectedVersion||r.state!=='FAILED'||!r.safeTerminal||r.cleanupPending||r.resourcesRetained||!a||a.state!=='FAILED_FENCED'||a.terminalEvidence?.versionKind!=='attempt'||a.terminalEvidence?.budgetState!=='SETTLED')fail('RETRY_CLAIM_REQUIRED');
            this.store.update('cloud_upload_batch_items',r,{retryAuthorized:true});
            const next=this.beginAttempt(who,itemId),serverAttemptId=uuid(),request={requestId:next.attempt.clientRequestId,sha256:r.sha256,...clone(r.metadata)};
            this.store.update('cloud_upload_item_attempts',next.attempt,{retryClaim:{confirmed:true,recorded:false,clientCommandId:input.clientCommandId,serverAttemptId}});
            this.store.update('cloud_upload_batches',this.owned(who,c.batch.batchId),{state:'QUEUED'});
            return {identity:clone(who),itemId,localAttemptId:next.attempt.attemptId,intentId:next.attempt.intentId,clientRequestId:next.attempt.clientRequestId,command:{originalRequestId:a.serverRequestId,clientCommandId:input.clientCommandId,newAttemptId:serverAttemptId,expectedVersion:input.qualificationVersion,request,confirmed:true}};
        });
        if(!sameIdentity(saved.identity,who))fail('AUTH_CHANGED');let c=this.schedulerContext(who,itemId);
        if(c.attempt?.attemptId!==saved.localAttemptId||c.item.intentId!==saved.intentId||c.item.clientRequestId!==saved.clientRequestId)fail('STALE_ATTEMPT');
        if(c.item.receipt)return this.recordReceipt(who,itemId,c.attempt.attemptId,{...c.item.receipt,currentAvailability:c.item.currentAvailability?.state??'UNKNOWN'});
        const ids={intentId:saved.intentId,clientRequestId:saved.clientRequestId};
        await this.upload.prepareWithIdentity(ids,c.item.sourceVersion,{assetId:c.item.representativeAssetId,sha256:c.item.sha256,...c.item.metadata});this.guard(who);
        await this.upload.bindSettledContext(ids,{identity:clone(who),batchId:c.item.batchId,itemId,localAttemptId:c.attempt.attemptId,metadataFingerprint:c.item.metadataFingerprint});this.guard(who);
        const result=await remote.retryClaim(who,c,saved.command);this.guard(who);
        c=this.schedulerContext(who,itemId);if(c.attempt.attemptId!==saved.localAttemptId)fail('STALE_ATTEMPT');
        if(result.commitState==='COMMITTED')return this.recordReceipt(who,itemId,c.attempt.attemptId,result.receipt);
        return this.store.transaction(()=>{
            let current=this.schedulerContext(who,itemId);if(current.attempt.attemptId!==saved.localAttemptId)fail('STALE_ATTEMPT');
            current=this.schedulerObserve(who,itemId,saved.localAttemptId,result,0);
            this.store.update('cloud_upload_item_attempts',current.attempt,{retryClaim:{...current.attempt.retryClaim,recorded:true}});
            return this.store.update('cloud_upload_batch_items',current.item,{intentPrepared:true,retryCount:0,nextRetryAt:null,schedulerBlocked:false});
        });
    }
    // Trusted internal seam. Each read binds the original attempt; no source I/O or caller paths.
    settledBinding(who, itemId, attemptId) {
        const c=this.schedulerContext(who,itemId),r=c.item,a=c.attempt,b=c.batch;
        if(b.epoch!==who.epoch||!a||a.attemptId!==id(attemptId)||r.receipt||a.receiptId||r.state!=='FAILED'||a.state!=='FAILED_FENCED'||!r.safeTerminal||!a.terminalEvidence||!a.localExit)fail('SETTLED_LEDGER_INVALID');
        if(a.intentId!==r.intentId||a.clientRequestId!==r.clientRequestId||a.metadataFingerprint!==r.metadataFingerprint||canonical(a.sourceVersion)!==canonical(r.sourceVersion)||r.serverRequestId!==a.serverRequestId)fail('SETTLED_BINDING_INVALID');
        const proof=terminationEvidence(a.terminalEvidence,who,c),exit=a.localExit;
        exact(exit,['operationId','kind','settledAt','itemId','localAttemptId','clientRequestId','identityFingerprint']);id(exit.operationId);integer(exit.settledAt);
        if(!['cancel','resolve'].includes(exit.kind)||exit.itemId!==r.itemId||exit.localAttemptId!==a.attemptId||exit.clientRequestId!==a.clientRequestId||exit.identityFingerprint!==fingerprint(who))fail('SETTLED_LEDGER_INVALID');
        return clone({version:1,identity:who,batchId:b.batchId,itemId:r.itemId,localAttemptId:a.attemptId,intentId:a.intentId,clientRequestId:a.clientRequestId,serverRequestId:a.serverRequestId,serverAttemptId:a.serverAttemptId,stateVersion:proof.stateVersion,admissionEpoch:a.admissionEpoch,sha256:r.sha256,bytes:r.declaredBytes,metadataFingerprint:a.metadataFingerprint,sourceVersion:a.sourceVersion,intentBinding:fingerprint({ids:{intentId:a.intentId,clientRequestId:a.clientRequestId},sourceVersion:a.sourceVersion,metadata:{assetId:r.representativeAssetId,sha256:r.sha256,...r.metadata}}),terminalEvidence:proof,localExit:exit,ownership:a.cleanupOwnership??null});
    }
    async cleanupSettled(who,itemId,attemptId) {
        let evidence;
        this.store.transaction(()=>{
            evidence=this.settledBinding(who,itemId,attemptId);
            const a=this.store.get('cloud_upload_item_attempts',{attemptId}),r=this.item(who,itemId).r;
            this.store.update('cloud_upload_item_attempts',a,{cleanupState:'PENDING'});
            this.store.update('cloud_upload_batch_items',r,{cleanupPending:true,resourcesRetained:true,retainedReason:'NON_SUCCESS_INTENT_RETAINED'});
        });
        const read=()=>this.settledBinding(who,itemId,attemptId);
        try {
            if(typeof this.upload.forgetSettled!=='function')fail('ADAPTER_UPDATE_REQUIRED');
            const result=await this.upload.forgetSettled({intentId:evidence.intentId,clientRequestId:evidence.clientRequestId},evidence,read,descriptor=>this.store.transaction(()=>{
                const current=read();if(canonical(current)!==canonical(evidence))fail('SETTLED_LEDGER_CHANGED');
                const a=this.store.get('cloud_upload_item_attempts',{attemptId});
                if(a.cleanupOwnership&&canonical(a.cleanupOwnership)!==canonical(descriptor))fail('SETTLED_BINDING_INVALID');
                this.store.update('cloud_upload_item_attempts',a,{cleanupOwnership:clone(descriptor)});
                return read();
            }));
            this.hook('after-settled-files');
            this.store.transaction(()=>{
                const current=read();
                if(result?.cleanupComplete!==true||result.durable!==true||result.evidenceFingerprint!==fingerprint(current))fail('SETTLED_CLEANUP_UNCONFIRMED');
                const a=this.store.get('cloud_upload_item_attempts',{attemptId}),r=this.item(who,itemId).r;
                this.store.update('cloud_upload_item_attempts',a,{cleanupState:'COMPLETE',cleanupResult:clone(result)});
                this.store.update('cloud_upload_batch_items',r,{cleanupPending:false,resourcesRetained:false,retainedReason:null,cleanupReason:null,retryCount:0,nextRetryAt:null,schedulerBlocked:false,lastCode:'NOT_COMMITTED'});
            });
            return {cleanupPending:false,cleanupComplete:true};
        } catch(error) {
            if(error?.code==='CRASH_TEST')throw error;
            // Never overwrite a late success or a new attempt, even on a failed final ACK.
            try {this.store.transaction(()=>{read();const r=this.item(who,itemId).r;this.store.update('cloud_upload_batch_items',r,{cleanupPending:true,resourcesRetained:true,retainedReason:'NON_SUCCESS_INTENT_RETAINED',cleanupReason:/^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code||'')?error.code:'SETTLED_CLEANUP_FAILED'});});}catch{}
            return {cleanupPending:true,code:error?.code||'SETTLED_CLEANUP_FAILED'};
        }
    }
    settle(b) { const rows = this.rows(b.batchId); if (rows.some(r => !terminal.has(r.state)))
        return b; const state = b.stopRequested ? 'STOPPED' : rows.some(r => r.state === 'FAILED' || r.state === 'CANCELLED') ? 'COMPLETED_WITH_ISSUES' : 'COMPLETED'; return b.state === state ? b : this.store.update('cloud_upload_batches', b, { state }); }
    summary(who, batchId) { const b = this.owned(who, batchId), rows = this.rows(batchId), counts = { uploaded: 0, reused: 0, already_present: 0, legacy_unrecorded: 0, committed: 0, pending: 0 }; for (const r of rows) {
        if (r.receipt) {
            counts.committed++;
            counts[r.resultMode]++;
        }
        else if (!terminal.has(r.state))
            counts.pending++;
    } return { ...this.view(b), counts }; }
}
