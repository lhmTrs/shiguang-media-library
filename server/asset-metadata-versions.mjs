// Explicit SQLite field evidence. Constructor/readiness are passive; registration
// alone installs the two tables and fixed invalidation triggers. No merge/IO job.
import crypto from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail = code => { throw Object.assign(Error(code), { code }); };
export const METADATA_FIELDS = Object.freeze(['note', 'favorite', 'confirmed', 'tags', 'capture']);
const columns = { note: ['note'], favorite: ['favorite'], confirmed: ['confirmed'], tags: ['tags'], capture: ['captured_ms', 'capture_source'] };
const clockSQL = `CREATE TABLE asset_metadata_clock (singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1),domain_id TEXT NOT NULL,seq INTEGER NOT NULL CHECK(seq>=0 AND seq<=9007199254740991),schema_sha256 TEXT NOT NULL,db_identity TEXT NOT NULL,coverage TEXT NOT NULL,version INTEGER NOT NULL CHECK(version=1))`;
const fieldsSQL = `CREATE TABLE asset_metadata_fields (asset_id TEXT NOT NULL,field TEXT NOT NULL CHECK(field IN ('note','favorite','confirmed','tags','capture')),domain_id TEXT NOT NULL,seq INTEGER NOT NULL CHECK(seq>0 AND seq<=9007199254740991),value_sha256 TEXT NOT NULL,modified_ms INTEGER NOT NULL,provenance TEXT NOT NULL CHECK(provenance='manual'),PRIMARY KEY(asset_id,field))`;
const triggers = METADATA_FIELDS.map(field => ({ name: 'sg_metadata_changed_' + field, type: 'trigger', sql: `CREATE TRIGGER sg_metadata_changed_${field} AFTER UPDATE OF ${columns[field].join(',')} ON assets WHEN ${columns[field].map(c => `OLD.${c} IS NOT NEW.${c}`).join(' OR ')} BEGIN DELETE FROM asset_metadata_fields WHERE asset_id=NEW.id AND field='${field}'; END` }));
for (const action of ['INSERT', 'DELETE'])
    triggers.push({ name: 'sg_metadata_' + action.toLowerCase(), type: 'trigger', sql: `CREATE TRIGGER sg_metadata_${action.toLowerCase()} AFTER ${action} ON assets BEGIN DELETE FROM asset_metadata_fields WHERE asset_id=${action === 'DELETE' ? 'OLD' : 'NEW'}.id; END` });
const objects = [{ name: 'asset_metadata_clock', type: 'table', sql: clockSQL }, { name: 'asset_metadata_fields', type: 'table', sql: fieldsSQL }, ...triggers], schemaHash = hash(objects), normalize = s => s.replace(/\s+/g, ' ').trim();
// Observe actual synchronous transaction settlement, including pre-existing batch
// outer transactions. Effects merge into the parent frame; rollback drops them.
const observers = new WeakMap(), instances = new WeakMap();
function observe(db) {
    if (observers.has(db)) return observers.get(db);
    const state = { frames: [] }, original = db.transaction.bind(db);
    db.transaction = fn => {
        const tx = original(fn);
        const wrap = action => function (...args) {
            const frame = { effects: new Map() };
            state.frames.push(frame);
            let value;
            try { value = action.apply(this, args); }
            catch (error) { state.frames.pop(); throw error; }
            state.frames.pop();
            const parent = state.frames.at(-1);
            if (parent) {
                for (const [key, effect] of frame.effects) parent.effects.set(key, effect);
            } else if (db.inTransaction) {
                if (frame.effects.size) fail('UNOBSERVED_TRANSACTION');
            } else {
                let failed = false;
                for (const effect of frame.effects.values()) {
                    try { effect(); } catch { failed = true; }
                }
                if (failed) throw Object.assign(Error('元数据已保存，后续任务未确认'), {
                    code: 'METADATA_POST_COMMIT_FAILED', committed: true,
                });
            }
            return value;
        };
        const wrapped = wrap(tx);
        for (const mode of ['deferred', 'immediate', 'exclusive']) {
            if (tx[mode]) wrapped[mode] = wrap(tx[mode]);
        }
        wrapped.default = wrapped;
        return wrapped;
    };
    observers.set(db, state);
    return state;
}
export function metadataVersionsFor(lib) { let value = instances.get(lib); if (!value || value.db !== lib.db) {
    value = new AssetMetadataVersions(lib);
    instances.set(lib, value);
} return value; }
export function metadataTransaction(lib, work) { return lib.metadataVersions ? lib.metadataVersions.transaction(work) : lib.db.transaction(work)(); }
export class AssetMetadataVersions {
    constructor(lib) { this.lib = lib; this.db = lib.db; this.observer = observe(this.db); }
    identity() { if (this.lib.db !== this.db || this.db.kind === 'mysql')
        fail('METADATA_ENGINE_UNSUPPORTED'); const file = this.db.name; if (typeof file !== 'string' || realpathSync(file) !== file)
        fail('METADATA_DB_CHANGED'); const s = lstatSync(file); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1)
        fail('METADATA_DB_CHANGED'); return hash({ dev: s.dev, ino: s.ino, birthtimeMs: s.birthtimeMs }); }
    readiness() { try {
        if (this.db.kind === 'mysql' || !this.lib.directoryClassification)
            return { ready: false, code: this.db.kind === 'mysql' ? 'METADATA_ENGINE_UNSUPPORTED' : 'METADATA_LEGACY_MODE_UNSUPPORTED' };
        const identity = this.identity(), sizes = this.db.prepare(`SELECT length(sql) n FROM sqlite_master WHERE name IN (${objects.map(() => '?').join(',')}) LIMIT 10`).all(...objects.map(o => o.name));
        if (sizes.some(r => !Number.isSafeInteger(r.n) || r.n > 8192))
            return { ready: false, code: 'METADATA_SCHEMA_UNKNOWN' };
        const rows = this.db.prepare(`SELECT name,type,sql FROM sqlite_master WHERE name IN (${objects.map(() => '?').join(',')}) LIMIT 10`).all(...objects.map(o => o.name));
        if (!rows.length)
            return { ready: false, code: 'METADATA_NOT_REGISTERED' };
        if (rows.length !== objects.length || objects.some(o => !rows.some(r => r.name === o.name && r.type === o.type && typeof r.sql === 'string' && r.sql.length < 8192 && normalize(r.sql) === normalize(o.sql))))
            return { ready: false, code: 'METADATA_SCHEMA_UNKNOWN' };
        const size = this.db.prepare('SELECT length(domain_id)+length(schema_sha256)+length(db_identity)+length(coverage) n FROM asset_metadata_clock LIMIT 2').all();
        if (size.length !== 1 || size[0].n > 512)
            return { ready: false, code: 'METADATA_BINDING_UNKNOWN' };
        const row = this.db.prepare('SELECT * FROM asset_metadata_clock WHERE singleton_id=1').get();
        if (!row || !UUID.test(row.domain_id) || !Number.isSafeInteger(row.seq) || row.seq < 0 || row.schema_sha256 !== schemaHash || row.db_identity !== identity || row.coverage !== 'directory-v1' || row.version !== 1)
            return { ready: false, code: 'METADATA_BINDING_UNKNOWN' };
        return { ready: true, code: 'METADATA_READY', domainId: row.domain_id, seq: row.seq, version: 1 };
    }
    catch {
        return { ready: false, code: 'METADATA_STATE_UNKNOWN' };
    } }
    register(input = { expectedVersion: 0 }) { if (!input || Object.keys(input).some(k => k !== 'expectedVersion') || input.expectedVersion !== 0)
        fail('METADATA_INVALID_REGISTRATION'); return this.transaction(() => { const state = this.readiness(); if (state.ready)
        return state; if (state.code !== 'METADATA_NOT_REGISTERED')
        fail(state.code); const identity = this.identity(); for (const o of objects)
        this.db.exec(o.sql); this.db.prepare('INSERT INTO asset_metadata_clock VALUES(1,?,0,?,?,?,1)').run(crypto.randomUUID(), schemaHash, identity, 'directory-v1'); const ready = this.readiness(); if (!ready.ready)
        fail('METADATA_REGISTRATION_FAILED'); return ready; }); }
    transaction(work) {
        const invoke = () => {
            const value = work();
            if (value && typeof value.then === 'function') fail('ASYNC_METADATA_TRANSACTION');
            return value;
        };
        // Existing MySQL adapter has no savepoints/inTransaction flag. Reuse its
        // observed outer transaction: another START TRANSACTION would commit it.
        // This preserves existing work only; MySQL field evidence stays UNKNOWN.
        if (this.db.kind === 'mysql' && this.observer.frames.length) return invoke();
        if (this.db.inTransaction && !this.observer.frames.length) fail('UNOBSERVED_TRANSACTION');
        const tx = this.db.transaction(invoke);
        return !this.db.inTransaction && tx.immediate ? tx.immediate() : tx();
    }
    afterCommit(effect, key = Symbol()) { const frame = this.observer.frames.at(-1); if (frame) {
        if (frame.effects.size >= 1000)
            fail('METADATA_EFFECT_LIMIT');
        frame.effects.set(key, effect);
    }
    else {
        if (this.db.inTransaction)
            fail('UNOBSERVED_TRANSACTION');
        effect();
    } }
    values(id) { if (!UUID.test(id || ''))
        fail('INVALID_METADATA_ASSET'); const size = this.db.prepare('SELECT COALESCE(length(note),0)+COALESCE(length(tags),0)+COALESCE(length(capture_source),0) n FROM assets WHERE id=?').get(id); if (!size || !Number.isSafeInteger(size.n) || size.n > 16384)
        fail('METADATA_VALUE_UNKNOWN'); const row = this.db.prepare('SELECT note,favorite,confirmed,tags,captured_ms,capture_source FROM assets WHERE id=?').get(id); if (!row)
        fail('METADATA_ASSET_MISSING'); const tags = JSON.parse(row.tags); if (typeof row.note !== 'string' || row.note.length > 4000 || ![0, 1].includes(row.favorite) || ![0, 1].includes(row.confirmed) || !Array.isArray(tags) || tags.length > 40 || tags.some(v => typeof v !== 'string' || v.length > 60) || row.captured_ms !== null && !Number.isFinite(row.captured_ms) || typeof row.capture_source !== 'string' || row.capture_source.length > 4000)
        fail('METADATA_VALUE_UNKNOWN'); return { note: row.note, favorite: !!row.favorite, confirmed: !!row.confirmed, tags, capture: [row.captured_ms, row.capture_source] }; }
    edit(id, work, { source = 'manual', fields = METADATA_FIELDS, forceUnknown = false } = {}) { if (!['manual', 'system', 'import'].includes(source) || !Array.isArray(fields) || fields.some(f => !METADATA_FIELDS.includes(f)))
        fail('INVALID_METADATA_PROVENANCE'); return this.transaction(() => { const ready = this.readiness(); let before = null; if (ready.ready) {
        try {
            before = this.values(id);
        }
        catch { }
    } const value = work(); if (value && typeof value.then === 'function')
        fail('ASYNC_METADATA_TRANSACTION'); if (!ready.ready || !before)
        return value; const after = this.values(id), changed = fields.filter(f => hash(before[f]) !== hash(after[f])); if (source !== 'manual') {
        for (const field of forceUnknown ? fields : changed)
            this.db.prepare('DELETE FROM asset_metadata_fields WHERE asset_id=? AND field=?').run(id, field);
        return value;
    } if (!changed.length)
        return value; const current = this.readiness(); if (!current.ready || current.domainId !== ready.domainId)
        fail('METADATA_STATE_CHANGED'); const seq = current.seq + 1; if (!Number.isSafeInteger(seq))
        fail('METADATA_CLOCK_OVERFLOW'); const update = this.db.prepare('UPDATE asset_metadata_clock SET seq=? WHERE singleton_id=1 AND seq=?').run(seq, current.seq); if (update.changes !== 1)
        fail('METADATA_CLOCK_CHANGED'); for (const field of changed)
        this.db.prepare('INSERT INTO asset_metadata_fields(asset_id,field,domain_id,seq,value_sha256,modified_ms,provenance) VALUES(?,?,?,?,?,?,?) ON CONFLICT(asset_id,field) DO UPDATE SET domain_id=excluded.domain_id,seq=excluded.seq,value_sha256=excluded.value_sha256,modified_ms=excluded.modified_ms,provenance=excluded.provenance').run(id, field, current.domainId, seq, hash(after[field]), Date.now(), 'manual'); return value; }); }
    invalidate(id, fields = METADATA_FIELDS) { if (this.readiness().ready)
        for (const field of fields) {
            if (!METADATA_FIELDS.includes(field))
                fail('INVALID_METADATA_FIELD');
            this.db.prepare('DELETE FROM asset_metadata_fields WHERE asset_id=? AND field=?').run(id, field);
        } }
    field(id, field) { if (!METADATA_FIELDS.includes(field))
        fail('INVALID_METADATA_FIELD'); const ready = this.readiness(); try {
        const value = this.values(id)[field];
        if (!ready.ready)
            return { known: false, code: ready.code, value };
        const size = this.db.prepare('SELECT length(domain_id)+length(value_sha256)+length(provenance) n FROM asset_metadata_fields WHERE asset_id=? AND field=?').get(id, field);
        if (!size || size.n > 128)
            return { known: false, code: 'METADATA_FIELD_UNKNOWN', value };
        const row = this.db.prepare('SELECT domain_id,seq,value_sha256,provenance FROM asset_metadata_fields WHERE asset_id=? AND field=?').get(id, field);
        if (row.domain_id !== ready.domainId || !Number.isSafeInteger(row.seq) || row.seq <= 0 || row.seq > ready.seq || row.provenance !== 'manual' || row.value_sha256 !== hash(value))
            return { known: false, code: 'METADATA_FIELD_UNKNOWN', value };
        return { known: true, value, domainId: row.domain_id, seq: row.seq };
    }
    catch {
        return { known: false, code: 'METADATA_VALUE_UNKNOWN' };
    } }
}
