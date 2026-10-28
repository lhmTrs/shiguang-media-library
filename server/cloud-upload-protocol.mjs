// UQ-01 internal contracts. No routes, timers, credentials, filesystem or network at import.
import crypto from 'node:crypto';
export const LIMITS = Object.freeze({ items: 5000, page: 100, scan: 500, body: 262144, intents: 50, bytes: 256000000 });
export class UploadBatchError extends Error {
    constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}
export const fail = (code, status) => { throw new UploadBatchError(code, status); };
export const uuid = () => crypto.randomUUID();
export const canonical = v => JSON.stringify(v, (_k, x) => x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
export const fingerprint = v => crypto.createHash('sha256').update(canonical(v)).digest('hex');
export const clone = v => JSON.parse(canonical(v));
export const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
export function exact(v, keys) { if (!plain(v) || Object.keys(v).some(k => !keys.includes(k)))
    fail('INVALID_REQUEST', 400); return v; }
export function text(v, max = 180, empty = false) { if (typeof v !== 'string' || v.length > max || (!empty && !v.length) || /[\u0000-\u001f\u007f-\u009f]/.test(v))
    fail('INVALID_REQUEST', 400); return v; }
export function id(v) { if (typeof v !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v))
    fail('INVALID_REQUEST', 400); return v; }
export function hash(v) { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v))
    fail('INVALID_REQUEST', 400); return v; }
export function integer(v, min = 0, max = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(v) || v < min || v > max)
    fail('INVALID_REQUEST', 400); return v; }
export function body(v) { if (Buffer.byteLength(canonical(v)) > LIMITS.body)
    fail('BODY_LIMIT', 413); return v; }
export function identity(v) { exact(v, ['cloudServiceKey', 'accountId', 'deviceId', 'librarySourceId', 'epoch']); hash(v.cloudServiceKey); for (const k of ['accountId', 'deviceId', 'librarySourceId'])
    id(v[k]); integer(v.epoch); return clone(v); }
export const namespace = who => ({ cloudServiceKey: who.cloudServiceKey, accountId: who.accountId });
export function sameIdentity(a, b, epoch = true) { return ['cloudServiceKey', 'accountId', 'deviceId', 'librarySourceId', ...(epoch ? ['epoch'] : [])].every(k => a[k] === b[k]); }
export function target(v) { exact(v, ['visibility', 'groupId']); if (!['PRIVATE', 'GROUP'].includes(v.visibility))
    fail('INVALID_REQUEST', 400); if (v.visibility === 'GROUP')
    id(v.groupId);
else if (v.groupId !== null)
    fail('INVALID_REQUEST', 400); return clone(v); }
export function segment(v, max = 60) { text(v, max, true); if (v !== v.trim() || /[\\/:]/.test(v) || ['.', '..'].includes(v))
    fail('INVALID_REQUEST', 400); return v; }
export function sourceVersion(v) { exact(v, ['rootIdentity', 'dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']); text(v.rootIdentity, 256); for (const k of ['dev', 'ino', 'size'])
    integer(v[k]); for (const k of ['mtimeMs', 'ctimeMs'])
    if (typeof v[k] !== 'number' || !Number.isFinite(v[k]) || v[k] < 0)
        fail('INVALID_REQUEST', 400); return clone(v); }
export function asset(v) { exact(v, ['assetId', 'rootId', 'sourceVersion', 'mediaKind', 'fileName', 'category', 'subcategory', 'target', 'sha256', 'declaredBytes']); id(v.assetId); id(v.rootId); sourceVersion(v.sourceVersion); if (!['MUSIC', 'SFX'].includes(v.mediaKind))
    fail('INVALID_REQUEST', 400); segment(v.fileName, 180); if (!v.fileName)
    fail('INVALID_REQUEST', 400); segment(v.category); segment(v.subcategory); if (!v.category && v.subcategory)
    fail('INVALID_REQUEST', 400); target(v.target); if (v.sha256 !== null)
    hash(v.sha256); integer(v.declaredBytes, 1, LIMITS.bytes); if (v.sourceVersion.size !== v.declaredBytes)
    fail('SOURCE_CHANGED'); return clone(v); }
export const metadata = r => ({ mediaKind: r.mediaKind, fileName: r.fileName, category: r.category, subcategory: r.subcategory, visibility: r.target.visibility, groupId: r.target.groupId, bytes: r.declaredBytes });
export const metadataFingerprint = r => fingerprint(metadata(r));
// Explicit field order, explicit null; no global/group version or manifest in this content proof.
export function groupFingerprint(previewId, sha, rows, representativeAssetId) { const selected = rows.filter(r => r.included).sort((a, b) => a.assetId.localeCompare(b.assetId)); const rep = selected.find(r => r.assetId === representativeAssetId); if (!rep)
    fail('REPRESENTATIVE_REQUIRED'); return crypto.createHash('sha256').update(JSON.stringify({ previewId, sha, members: selected.map(r => ({ assetId: r.assetId, sourceVersion: r.sourceVersion })), representativeAssetId, bytes: rep.declaredBytes, mediaKind: rep.mediaKind, fileName: rep.fileName, category: rep.category, subcategory: rep.subcategory, visibility: rep.target.visibility, groupId: rep.target.groupId }), 'utf8').digest('hex'); }
export const groupKey = r => r.sha256 || 'unknown:' + r.assetId;
export function publicItem(r) { return { assetId: r.assetId, ordinal: r.ordinal, fileName: r.fileName, mediaKind: r.mediaKind, category: r.category, subcategory: r.subcategory, sourceVersion: clone(r.sourceVersion), sha256: r.sha256, classification: r.classification || 'UNKNOWN', selectable: r.classification === 'NEW', included: r.included, groupVersion: r.groupVersion, confirmationVersion: r.confirmationVersion, representativeAssetId: r.representativeAssetId, representativeFingerprint: r.representativeFingerprint }; }
// Current availability is a bounded observation, never part of immutable commit evidence.
const AVAILABILITY = Object.freeze({
    AVAILABLE: 'AVAILABLE', PRIVATE: 'PRIVATE', UNAVAILABLE: 'UNAVAILABLE',
    RELEASED: 'HISTORICAL', ADMIN_REMOVED: 'HISTORICAL', ADMIN_DELETING: 'HISTORICAL',
    ADMIN_DELETED: 'HISTORICAL', REMOVAL_PENDING: 'HISTORICAL', REMOVED: 'HISTORICAL',
    UNKNOWN: 'NEEDS_RECONCILIATION', REVIEW_REQUIRED: 'NEEDS_RECONCILIATION',
    NEEDS_RECONCILIATION: 'NEEDS_RECONCILIATION', MISSING: 'NEEDS_RECONCILIATION',
    QUARANTINED: 'NEEDS_RECONCILIATION', FAILED: 'NEEDS_RECONCILIATION',
});
export function availabilityProjection(value) {
    if (typeof value !== 'string' || !Object.hasOwn(AVAILABILITY, value)) fail('RECEIPT_INVALID');
    return { state: value, classification: AVAILABILITY[value] };
}
// Compatibility for a receipt committed by the first candidate: preserve its original JSON,
// but exclude that candidate's availability decoration when comparing historical facts.
export function receiptFacts(receipt) {
    const { currentAvailability: _observation, ...facts } = receipt;
    return facts;
}
export function authoritativeReceipt(raw, attempt, item) {
    exact(raw, ['receiptId', 'clientRequestId', 'canonicalRequestId', 'attemptId', 'audioId', 'blobId', 'shareId', 'sha256', 'bytes', 'verifiedBytes', 'storageGeneration', 'admissionEpoch', 'mode', 'targetMatched', 'committedAt', 'currentAvailability']);
    for (const k of ['receiptId', 'clientRequestId', 'canonicalRequestId', 'shareId'])
        id(raw[k]);
    if (raw.attemptId !== null)
        id(raw.attemptId);
    const blob = id(raw.blobId || raw.audioId);
    if (raw.blobId && raw.audioId && raw.blobId !== raw.audioId)
        fail('RECEIPT_INVALID');
    hash(raw.sha256);
    const bytes = integer(raw.verifiedBytes ?? raw.bytes, 1, LIMITS.bytes);
    if (raw.bytes !== undefined && raw.verifiedBytes !== undefined && raw.bytes !== raw.verifiedBytes)
        fail('RECEIPT_INVALID');
    integer(raw.storageGeneration, 1);
    integer(raw.admissionEpoch);
    if (!['uploaded', 'reused', 'already_present', 'legacy_unrecorded'].includes(raw.mode) || typeof raw.targetMatched !== 'boolean' || typeof raw.committedAt !== 'string' || !Number.isFinite(Date.parse(raw.committedAt)))
        fail('RECEIPT_INVALID');
    if (raw.clientRequestId !== attempt.clientRequestId || raw.sha256 !== item.sha256 || bytes !== item.declaredBytes || (raw.attemptId !== null && attempt.serverAttemptId && raw.attemptId !== attempt.serverAttemptId))
        fail('RECEIPT_INVALID');
    if ((['uploaded', 'reused'].includes(raw.mode) && (raw.attemptId === null || raw.targetMatched !== true)))
        fail('RECEIPT_INVALID');
    availabilityProjection(raw.currentAvailability);
    return { receiptId: raw.receiptId, clientRequestId: raw.clientRequestId, canonicalRequestId: raw.canonicalRequestId, attemptId: raw.attemptId, audioId: blob, blobId: blob, shareId: raw.shareId, sha256: raw.sha256, bytes, verifiedBytes: bytes, storageGeneration: raw.storageGeneration, admissionEpoch: raw.admissionEpoch, mode: raw.mode, targetMatched: raw.targetMatched, committedAt: raw.committedAt };
}
export function cursor(secret, payload) { const encoded = Buffer.from(canonical(payload)).toString('base64url'); return encoded + '.' + crypto.createHmac('sha256', secret).update(encoded).digest('hex'); }
export function readCursor(secret, token, expected) { if (typeof token !== 'string' || token.length > 2048)
    fail('PREVIEW_STALE'); const [encoded, mac, extra] = token.split('.'); const expectedMac = crypto.createHmac('sha256', secret).update(encoded || '').digest('hex'); if (extra || typeof mac !== 'string' || mac.length !== 64 || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expectedMac)))
    fail('PREVIEW_STALE'); let p; try {
    p = JSON.parse(Buffer.from(encoded, 'base64url').toString());
}
catch {
    fail('PREVIEW_STALE');
} for (const [k, v] of Object.entries(expected))
    if (p[k] !== v)
        fail('PREVIEW_STALE'); integer(p.lastOrdinal, -1); return p.lastOrdinal; }

// UQ03A: local orchestration limits; never changes server admission or enables networking.
export const SCHEDULER_LIMITS = Object.freeze({
    requestsPerMinute: 24, pending: 10, intents: 50, intentBytes: 262144,
    snapshotBytes: 512000000, retries: 8, scanBatches: 8, page: 100,
    pollMs: 30000, operationMs: 300000, maxRetryMs: 86400000,
});
export function uploadSafety(raw, item) {
    if (!plain(raw) || raw.protocol !== 2 || raw.writeMode !== 'READY' || raw.canCreateUploads !== true)
        fail('PROTOCOL_UPDATE_REQUIRED', 503);
    const required = ['sqlEligibility','contentRowLock','generationBindings','adminBarrier','integrityGate','fileOperationFence','legacyWriteFence'];
    if (!plain(raw.requiredSafety) || required.some(k => raw.requiredSafety[k] !== true)) fail('PROTOCOL_UPDATE_REQUIRED', 503);
    if (!plain(raw.limits)) fail('PROTOCOL_UPDATE_REQUIRED', 503);
    integer(raw.limits.maxFileBytes, 1); integer(raw.limits.eligibilityMaxItems, 1);
    if (item.declaredBytes > Math.min(raw.limits.maxFileBytes, LIMITS.bytes)) fail('FILE_TOO_LARGE');
    return { reuse: raw.optional?.reuse === true };
}
export function uploadResources(raw) {
    exact(raw, ['known','activeIntents','intentBytes','snapshotBytes']);
    if (raw.known !== true) fail('RESOURCE_STATE_UNKNOWN');
    for (const key of ['activeIntents','intentBytes','snapshotBytes']) integer(raw[key]);
    if (raw.activeIntents > SCHEDULER_LIMITS.intents || raw.intentBytes > SCHEDULER_LIMITS.intentBytes || raw.snapshotBytes > SCHEDULER_LIMITS.snapshotBytes) fail('LOCAL_RESOURCE_LIMIT');
    return clone(raw);
}
export function retryDeadline(value, now, retryCount) {
    integer(now); integer(retryCount, 0, SCHEDULER_LIMITS.retries);
    let delay = Math.min(300000, 1000 * 2 ** retryCount);
    if (value !== undefined && value !== null) {
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) delay = value * 1000;
        else if (typeof value === 'string' && value.length <= 100 && /^\d+(?:\.\d+)?$/.test(value)) delay = Number(value) * 1000;
        else if (typeof value === 'string' && value.length <= 100 && Number.isFinite(Date.parse(value))) delay = Math.max(0, Date.parse(value) - now);
        else fail('INVALID_RETRY_AFTER');
    }
    if (!Number.isFinite(delay) || delay > SCHEDULER_LIMITS.maxRetryMs) fail('RETRY_AFTER_REQUIRES_ACTION');
    return integer(now + Math.max(500, Math.ceil(delay)));
}
export function requestObservation(raw, context) {
    exact(raw, ['clientRequestId','canonicalRequestId','attemptId','requestState','stateVersion','admissionEpoch','requestVersion','qualificationVersion']);
    if (raw.clientRequestId !== context.item.clientRequestId) fail('STALE_ATTEMPT');
    if (!['PENDING','APPROVED','REJECTED','EXPIRED','CANCELLED','NOT_CREATED'].includes(raw.requestState)) fail('INVALID_REMOTE_STATE');
    integer(raw.stateVersion);integer(raw.admissionEpoch);
    if(raw.requestVersion!==undefined){integer(raw.requestVersion);integer(raw.qualificationVersion);if(raw.requestVersion!==raw.stateVersion)fail('INVALID_REMOTE_VERSION');}
    if(context.attempt.admissionEpoch!==undefined&&context.attempt.admissionEpoch!==raw.admissionEpoch)fail('ADMISSION_CHANGED');
    if(context.attempt.remoteStateVersion===raw.stateVersion&&context.attempt.remoteRequestState&&context.attempt.remoteRequestState!==raw.requestState)fail('STALE_REMOTE_STATE');
    if (raw.requestState === 'NOT_CREATED') {
        if (raw.canonicalRequestId !== null || raw.attemptId !== null || context.item.serverRequestId) fail('REMOTE_MAPPING_CONFLICT');
    } else {
        id(raw.canonicalRequestId); id(raw.attemptId);
        if ((context.attempt.serverRequestId && raw.canonicalRequestId !== context.attempt.serverRequestId) ||
            (context.attempt.serverAttemptId && raw.attemptId !== context.attempt.serverAttemptId)) fail('REMOTE_MAPPING_CONFLICT');
    }
    if (context.attempt.remoteStateVersion !== undefined && raw.stateVersion < context.attempt.remoteStateVersion) fail('STALE_REMOTE_STATE');
    return clone(raw);
}
export function terminationEvidence(raw, who, context) {
    exact(raw, ['proofId','cloudServiceKey','accountId','deviceId','librarySourceId','epoch','clientRequestId','canonicalRequestId','attemptId','stateVersion','admissionEpoch','commitState','workerState','operationsState','budgetState','attemptState','observedAt','versionKind']);
    id(raw.proofId); integer(raw.stateVersion); integer(raw.admissionEpoch);
    const attemptVersioned=raw.versionKind==='attempt';
    if((raw.versionKind!==undefined||raw.budgetState!==undefined||raw.attemptState!==undefined||raw.observedAt!==undefined)&&!attemptVersioned)fail('NEEDS_RECONCILIATION');
    if(attemptVersioned&&(raw.budgetState!=='SETTLED'||!['REJECTED','EXPIRED','CANCELLED','FAILED_FENCED'].includes(raw.attemptState)||typeof raw.observedAt!=='string'||!Number.isFinite(Date.parse(raw.observedAt))))fail('NEEDS_RECONCILIATION');
    if (!sameIdentity(raw, who) || raw.clientRequestId !== context.item.clientRequestId ||
        !context.attempt.serverRequestId || !context.attempt.serverAttemptId ||
        raw.canonicalRequestId !== context.attempt.serverRequestId || raw.attemptId !== context.attempt.serverAttemptId ||
        raw.stateVersion < (attemptVersioned?(context.attempt.remoteAttemptVersion??0):(context.attempt.remoteStateVersion??0)) || raw.admissionEpoch!==context.attempt.admissionEpoch || raw.commitState !== 'NOT_COMMITTED' ||
        raw.workerState !== 'SETTLED' || raw.operationsState !== 'SETTLED') fail('NEEDS_RECONCILIATION');
    return clone(raw);
}
