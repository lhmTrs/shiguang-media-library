import { canonical, clone, fail, integer } from './cloud-upload-protocol.mjs';
import crypto from 'node:crypto';
const c = (type, required = false) => ({ type, required });
const u = () => c('VARCHAR(36)', true), h = () => c('CHAR(64)', true), t = () => c('TEXT'), n = (required = false) => c('BIGINT', required), s = (size = 32, required = false) => c(`VARCHAR(${size})`, required);
const common = { version: n(true), createdAt: n(true), updatedAt: n(true), recordJson: c('TEXT', true) };
const ns = { cloudServiceKey: h(), accountId: u() };
// All indexed columns have explicit bounded types, including SQLite-to-MySQL conversion.
export const UPLOAD_TABLES = Object.freeze({
    cloud_upload_previews: { pk: ['previewId'], unique: [['cloudServiceKey', 'accountId', 'clientCommandId']], columns: { previewId: u(), clientCommandId: u(), ...ns, deviceId: u(), librarySourceId: u(), scopeJson: t(), rootRevision: n(true), scanCompletedAt: n(true), manifestFingerprint: h(), status: s(32, true), cursorSecret: h(), ...common } },
    cloud_upload_preview_items: { pk: ['previewId', 'ordinal'], unique: [['previewId', 'assetId']], columns: { previewId: u(), ordinal: n(true), assetId: u(), rootId: u(), sourceVersion: t(), mediaKind: s(8, true), fileName: s(180, true), category: s(60, true), subcategory: s(60, true), targetJson: t(), sha256: c('CHAR(64)'), declaredBytes: n(true), eligibilitySnapshot: t(), representativeAssetId: c('VARCHAR(36)'), representativeFingerprint: c('CHAR(64)'), groupVersion: n(true), confirmationVersion: n(), included: n(true), ...common } },
    cloud_upload_batches: { pk: ['batchId'], unique: [['cloudServiceKey', 'accountId', 'clientCommandId']], columns: { batchId: u(), clientCommandId: u(), payloadFingerprint: h(), previewId: u(), previewVersion: n(true), manifestFingerprint: h(), ...ns, deviceId: u(), librarySourceId: u(), state: s(32, true), stopRequested: n(true), ...common } },
    cloud_upload_batch_items: { pk: ['itemId'], unique: [['batchId', 'ordinal']], columns: { itemId: u(), batchId: u(), ordinal: n(true), representativeAssetId: c('VARCHAR(36)'), sourceVersion: t(), metadataFingerprint: h(), state: s(32, true), resultMode: s(), sha256: c('CHAR(64)'), declaredBytes: n(true), currentAttemptId: c('VARCHAR(36)'), intentId: c('VARCHAR(36)'), clientRequestId: c('VARCHAR(36)'), serverRequestId: c('VARCHAR(36)'), receiptJson: t(), lastCode: s(64), retryCount: n(true), nextRetryAt: n(), ...common } },
    cloud_upload_item_attempts: { pk: ['attemptId'], unique: [['itemId', 'attemptNo'], ['cloudServiceKey', 'accountId', 'clientRequestId']], columns: { attemptId: u(), itemId: u(), ...ns, attemptNo: n(true), intentId: u(), clientRequestId: u(), metadataFingerprint: h(), sourceVersion: t(), serverRequestId: c('VARCHAR(36)'), serverAttemptId: c('VARCHAR(36)'), state: s(32, true), receiptId: c('VARCHAR(36)'), ...common } },
    cloud_upload_commands: { pk: ['cloudServiceKey', 'accountId', 'clientCommandId'], unique: [], columns: { ...ns, clientCommandId: u(), targetKind: s(32, true), targetId: s(80, true), action: s(32, true), payloadFingerprint: h(), expectedVersion: n(true), resultJson: c('TEXT', true), resultVersion: n(true), ...common } },
    cloud_upload_active_claims: { pk: ['claimKey'], unique: [['itemId']], columns: { claimKey: h(), itemId: u(), ...ns, assetId: u(), sourceVersion: t(), targetJson: t(), metadataFingerprint: h(), attemptId: u(), ...common } },
    cloud_upload_eligibility_cache: { pk: ['cloudServiceKey', 'accountId', 'sha256'], unique: [], columns: { ...ns, sha256: h(), verifiedSourceVersion: t(), serverStateVersion: n(true), admissionEpoch: n(true), generation: n(), checkedAt: n(true), projection: t(), ...common } },
});
export const sqlName = k => k.replace(/[A-Z]/g, x => '_' + x.toLowerCase());
const keys = (table) => { if (!Object.hasOwn(UPLOAD_TABLES, table))
    fail('INVALID_TABLE'); return UPLOAD_TABLES[table]; };
export function uploadMysqlColumnType(table, col) { const spec = Object.entries(keys(table).columns).find(([name]) => sqlName(name) === col.name)?.[1]; if (!spec)
    fail('INVALID_COLUMN'); return spec.type; }
const ENUMS = {
    status: ['PREPARING', 'READY', 'STALE', 'CANCELLED'],
    mediaKind: ['MUSIC', 'SFX'],
};
const STATES = {
    cloud_upload_batches: ['DRAFT', 'PREPARING_PREVIEW', 'READY', 'QUEUED', 'RUNNING', 'WAITING_APPROVAL', 'PAUSED', 'STOPPING', 'NEEDS_ATTENTION', 'COMPLETED', 'COMPLETED_WITH_ISSUES', 'STOPPED'],
    cloud_upload_batch_items: ['QUEUED', 'HASHING', 'HASHED', 'REQUESTING', 'WAITING_APPROVAL', 'READY', 'CHECKING_REUSE', 'PROVING_POSSESSION', 'REUSE_COMMITTING', 'PREPARING', 'UPLOADING', 'RECONCILING', 'RETRY_WAIT', 'NEEDS_CONFIRMATION', 'COMMITTED', 'SKIPPED', 'FAILED', 'CANCELLED'],
    cloud_upload_item_attempts: ['RESERVED', 'PREPARED', 'WAITING_APPROVAL', 'READY', 'TRANSFERRING', 'COMMITTING', 'COMMITTED', 'RECONCILING', 'REJECTED', 'EXPIRED', 'CANCELLED', 'FAILED_FENCED'],
};
export function uploadConstraints(table) { const def = keys(table), checks = []; for (const [key, col] of Object.entries(def.columns)) {
    const name = sqlName(key);
    if (col.type === 'BIGINT')
        checks.push(`CHECK(${name} IS NULL OR (${name} >= 0 AND ${name} <= 9007199254740991))`);
    const values = key === 'state' ? STATES[table] : ENUMS[key];
    if (values)
        checks.push(`CHECK(${name} IN (${values.map(v => "'" + v + "'").join(',')}))`);
    if (['included', 'stopRequested'].includes(key))
        checks.push(`CHECK(${name} IN (0,1))`);
} return [`PRIMARY KEY(${def.pk.map(sqlName).join(',')})`, ...def.unique.map(cols => `UNIQUE(${cols.map(sqlName).join(',')})`), ...checks]; }
export function uploadOrderBy(table) { return keys(table).pk.map(sqlName).join(','); }
export class CloudUploadBatchStore {
    constructor(db, { clock = () => Date.now(), hook = () => { } } = {}) { this.db = db; this.clock = clock; this.hook = hook; }
    // Explicit restore safety query only. No init, writes, claims or remote activity.
    repairState(assetIds, { inTransaction = false } = {}) {
        if (!Array.isArray(assetIds) || !assetIds.length || assetIds.length > 50 || assetIds.some(v => typeof v !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v))) return { known:false, state:'unknown' };
        try {
            if(!inTransaction)return this.db.transaction(()=>this.repairState(assetIds,{inTransaction:true}))();
            let bytes=0;const snapshots=[],records=[];
            for(const [table,def] of Object.entries(UPLOAD_TABLES)) {
                const sizing=Object.keys(def.columns).map(key=>`COALESCE(LENGTH(CAST(${sqlName(key)} AS ${this.db.kind==='mysql'?'BINARY':'BLOB'})),0)`).join('+');
                const sizes=this.db.prepare(`SELECT (${sizing}) AS bytes FROM ${table} LIMIT 129`).all();
                if(sizes.length>128)return {known:false,state:'unknown'};
                for(const row of sizes){bytes+=Number(row.bytes);if(!Number.isSafeInteger(bytes)||bytes>524288)return {known:false,state:'unknown'};}
                const rows=this.db.prepare(`SELECT * FROM ${table} ORDER BY ${uploadOrderBy(table)} LIMIT 129`).all();
                if(rows.length>128)return {known:false,state:'unknown'};
                for(const row of rows){
                    const record=this.decode(row), values=this.values(table,record), cols=Object.keys(def.columns);
                    if(cols.some((key,i)=>{const a=row[sqlName(key)],b=values[i];return a===null||b===null?a!==b:String(a)!==String(b);}))return {known:false,state:'unknown'};
                    records.push({table,record});
                }
                snapshots.push([table,rows]);
            }
            const contains=(value,depth=0)=>{
                if(depth>20)throw Error('bounded');
                if(typeof value==='string')return assetIds.includes(value);
                if(Array.isArray(value))return value.some(v=>contains(v,depth+1));
                if(value&&typeof value==='object')return Object.values(value).some(v=>contains(v,depth+1));
                return false;
            };
            // Match exact structured UUID values, never substring search or replacement.
            const related=records.some(({record})=>contains(record));
            return {known:true,state:related?'blocked':'idle',version:crypto.createHash('sha256').update(canonical(snapshots)).digest('hex')};
        } catch { return {known:false,state:'unknown'}; }
    }
    init() { for (const [table, def] of Object.entries(UPLOAD_TABLES)) {
        const columns = Object.entries(def.columns).map(([key, col]) => `${sqlName(key)} ${col.type}${col.required ? ' NOT NULL' : ''}${key === 'groupVersion' ? ' DEFAULT 0' : ''}`);
        this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (${[...columns, ...uploadConstraints(table)].join(',')})${this.db.kind === 'mysql' ? ' ENGINE=InnoDB' : ''}`);
    } return this; }
    transaction(fn) { const wrapped = this.db.transaction(() => { const result = fn(); if (result && typeof result.then === 'function')
        fail('ASYNC_TRANSACTION'); return result; }); return wrapped.immediate ? wrapped.immediate() : wrapped(); }
    where(table, where) { const def = keys(table); for (const k of Object.keys(where))
        if (!Object.hasOwn(def.columns, k))
            fail('INVALID_COLUMN'); return { clause: Object.keys(where).map(k => `${sqlName(k)} = ?`).join(' AND '), values: Object.values(where) }; }
    decode(row) { if (!row)
        return null; let record; try {
        record = JSON.parse(row.record_json);
    }
    catch {
        fail('STORE_INVALID');
    } integer(record.version); if (record.version !== Number(row.version))
        fail('STORE_INVALID'); return record; }
    get(table, where) { const q = this.where(table, where); return this.decode(this.db.prepare(`SELECT * FROM ${table} WHERE ${q.clause}`).get(...q.values)); }
    list(table, where = {}, { after = null, limit = 5001, order = null } = {}) { integer(limit, 1, 5001); const def = keys(table), q = this.where(table, where); let clause = q.clause, values = q.values; if (after !== null) {
        const field = order || def.pk.at(-1);
        if (!Object.hasOwn(def.columns, field))
            fail('INVALID_COLUMN');
        clause += (clause ? ' AND ' : '') + `${sqlName(field)} > ?`;
        values.push(after);
    } const sort = order || def.pk.at(-1); if (!Object.hasOwn(def.columns, sort))
        fail('INVALID_COLUMN'); return this.db.prepare(`SELECT * FROM ${table}${clause ? ' WHERE ' + clause : ''} ORDER BY ${sqlName(sort)} LIMIT ?`).all(...values, limit).map(row => this.decode(row)); }
    values(table, record) { const def = keys(table); return Object.entries(def.columns).map(([key, col]) => { let value = key === 'recordJson' ? canonical(record) : record[key]; if (value === undefined && key === 'scopeJson')
        value = record.scope; if (value === undefined && key === 'targetJson')
        value = record.target; if (value === undefined && key === 'receiptJson')
        value = record.receipt; if (value === undefined && key === 'resultJson')
        value = record.result; if (value !== null && typeof value === 'object')
        value = canonical(value); if (typeof value === 'boolean')
        value = value ? 1 : 0; if (value === undefined)
        value = null; if (col.required && value === null)
        fail('STORE_INVALID'); return value; }); }
    insert(table, input) { const now = this.clock(), r = { ...clone(input), version: input.version ?? 0, createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now }; const cols = Object.keys(keys(table).columns).map(sqlName); this.db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...this.values(table, r)); return r; }
    update(table, current, patch) { const def = keys(table); integer(current.version, 0, Number.MAX_SAFE_INTEGER - 1); for (const key of [...def.pk, 'cloudServiceKey', 'accountId'])
        if (Object.hasOwn(patch, key) && canonical(patch[key]) !== canonical(current[key]))
            fail('IMMUTABLE_FIELD'); if (current.receipt && Object.hasOwn(patch, 'receipt') && canonical(patch.receipt) !== canonical(current.receipt))
        fail('RECEIPT_CONFLICT'); if (table === 'cloud_upload_item_attempts') {
        for (const key of ['itemId', 'intentId', 'clientRequestId', 'attemptNo', 'sourceVersion', 'metadataFingerprint'])
            if (Object.hasOwn(patch, key) && canonical(patch[key]) !== canonical(current[key]))
                fail('IMMUTABLE_FIELD');
        for (const key of ['serverRequestId', 'serverAttemptId'])
            if (current[key] && Object.hasOwn(patch, key) && patch[key] !== current[key])
                fail('IMMUTABLE_FIELD');
    } const r = { ...current, ...clone(patch), version: current.version + 1, createdAt: current.createdAt, updatedAt: this.clock() }, where = Object.fromEntries(def.pk.map(k => [k, current[k]])), q = this.where(table, where), columns = Object.keys(def.columns); const result = this.db.prepare(`UPDATE ${table} SET ${columns.map(k => sqlName(k) + ' = ?').join(',')} WHERE ${q.clause} AND version = ?`).run(...this.values(table, r), ...q.values, current.version); if (result.changes !== 1)
        fail('VERSION_CONFLICT'); return r; }
    removeClaim(claim) { const q = this.where('cloud_upload_active_claims', { claimKey: claim.claimKey, itemId: claim.itemId, attemptId: claim.attemptId, version: claim.version }); return this.db.prepare(`DELETE FROM cloud_upload_active_claims WHERE ${q.clause}`).run(...q.values).changes === 1; }
}
