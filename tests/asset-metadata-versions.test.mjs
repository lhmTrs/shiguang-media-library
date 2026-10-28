import { Readable } from 'node:stream';
import { CloudAudioService } from '../server/cloud-audio-service.mjs';
import { CloudAuthError } from '../server/cloud-auth.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { Library } from '../server/library.mjs';
import { Tags } from '../server/tags.mjs';
import { MetadataBatches } from '../server/metadata-batches.mjs';
import { MusicCategories, AssetCategories } from '../server/music-categories.mjs';
import { reconcileRoot, createManifestSync } from '../server/reconcile.mjs';
import { entryFromAsset, metaFromEntry, readManifest, writeManifest } from '../server/fs-manifest.mjs';
import { mysqlColumnType } from '../server/mysql.mjs';
const retain = [], options = { tagFiles: false, hashBudgetFiles: 0, hashBudgetBytes: 0, matchHashBudgetFiles: 0 };
async function fixture(t, { register = true, directory = true } = {}) { const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sg-metadata-evidence-'))); retain.push({ base, policy: 'RETAIN_ALL', setup: true }); const lib = await new Library(path.join(base, 'data'), { directoryClassification: directory }).init(); const effects = []; lib.enqueue = (id) => effects.push({ kind: 'enqueue', id, inTransaction: lib.db.inTransaction }); lib.onMetadataChanged = root => effects.push({ kind: 'manifest', root, inTransaction: lib.db.inTransaction }); const folder = path.join(base, 'root'); await fs.mkdir(path.join(folder, '类别'), { recursive: true }); const root = await lib.addRoot(folder, 'sfx'); for (const name of ['a.wav', 'b.wav'])
    await fs.writeFile(path.join(folder, '类别', name), 'synthetic audio metadata bytes'); await reconcileRoot(lib, root, options); lib.db.prepare("UPDATE assets SET probe='ready',capture_status='ready'").run(); const ids = lib.db.prepare('SELECT id FROM assets ORDER BY name').all().map(r => r.id); if (register)
    lib.metadataVersions.register(); t.after(() => lib.db.close()); return { base, lib, root, ids, effects, m: lib.metadataVersions }; }
test.after(() => console.log(JSON.stringify({ registered: retain, after: 'known DB/service handles only; no filesystem inventory or recursive cleanup' })));
test('passive initialization does not install evidence schema; explicit registration preserves legacy rows and domain on reopen', async (t) => { const f = await fixture(t, { register: false }), before = f.lib.db.prepare('SELECT * FROM assets ORDER BY id').all(); assert.equal(f.m.readiness().code, 'METADATA_NOT_REGISTERED'); f.lib.patch(f.ids[0], { note: 'ordinary unregistered' }); assert.equal(f.lib.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'asset_metadata_%' OR name LIKE 'sg_metadata_%'").get().n, 0); const ready = f.m.register(); assert.equal(ready.ready, true); assert.equal(ready.seq, 0); assert.equal(f.m.field(f.ids[0], 'note').known, false); assert.equal(f.lib.asset(f.ids[1]).note, before.find(r => r.id === f.ids[1]).note); assert.equal(f.m.register().domainId, ready.domainId); const reopened = await new Library(f.lib.dataDir, { directoryClassification: true }).init(); t.after(() => reopened.db.close()); assert.equal(reopened.metadataVersions.readiness().domainId, ready.domainId); });
test('real patch shares domain and increasing sequence across assets, preserves empty/false/null, and no-op keeps sequence', async (t) => { const f = await fixture(t), [a, b] = f.ids; f.lib.patch(a, { note: 'older', favorite: true, confirmed: true, capturedAt: '2026-10-20T12:00' }); const first = f.m.field(a, 'note'); assert.equal(first.known, true); f.lib.patch(b, { note: 'newer' }); assert.ok(f.m.field(b, 'note').seq > first.seq); f.lib.patch(a, { note: '', favorite: false, confirmed: false, capturedAt: '' }); for (const key of ['note', 'favorite', 'confirmed', 'capture'])
    assert.equal(f.m.field(a, key).known, true); assert.equal(f.m.field(a, 'note').value, ''); assert.equal(f.m.field(a, 'favorite').value, false); assert.deepEqual(f.m.field(a, 'capture').value, [null, '']); const seq = f.m.readiness().seq; f.lib.patch(a, { note: '', favorite: false, confirmed: false, capturedAt: '' }); assert.equal(f.m.readiness().seq, seq); assert.ok(f.effects.every(e => e.inTransaction === false)); });
test('capture plus invalid tags is zero write and zero early enqueue; native outer rollback restores field evidence and drops effects', async (t) => { const f = await fixture(t), a = f.ids[0]; f.lib.patch(a, { note: 'before', capturedAt: '2026-10-20T12:00' }); const before = f.lib.db.prepare('SELECT * FROM assets WHERE id=?').get(a), evidence = f.m.field(a, 'note'), seq = f.m.readiness().seq; f.effects.length = 0; assert.throws(() => f.lib.patch(a, { capturedAt: '', tags: ['x'.repeat(61)] })); assert.deepEqual(f.lib.db.prepare('SELECT * FROM assets WHERE id=?').get(a), before); assert.deepEqual(f.effects, []); assert.throws(() => f.lib.db.transaction(() => { f.lib.patch(a, { capturedAt: '', note: 'temporary' }); assert.deepEqual(f.effects, []); throw Error('controlled rollback'); })()); assert.deepEqual(f.lib.db.prepare('SELECT * FROM assets WHERE id=?').get(a), before); assert.deepEqual(f.m.field(a, 'note'), evidence); assert.equal(f.m.readiness().seq, seq); assert.deepEqual(f.effects, []); });
test('real trigger detects direct SQL A-B-A and another connection; rollback does not invalidate committed evidence', async (t) => { const f = await fixture(t), a = f.ids[0]; f.lib.patch(a, { note: 'A' }); const original = f.m.field(a, 'note'); assert.throws(() => f.lib.db.transaction(() => { f.lib.db.prepare('UPDATE assets SET note=? WHERE id=?').run('B', a); throw Error('rollback'); })()); assert.deepEqual(f.m.field(a, 'note'), original); const other = new Database(f.lib.db.name); t.after(() => other.close()); other.prepare('UPDATE assets SET note=? WHERE id=?').run('B', a); other.prepare('UPDATE assets SET note=? WHERE id=?').run('A', a); assert.equal(f.lib.asset(a).note, 'A'); assert.equal(f.m.field(a, 'note').known, false); assert.equal(f.m.readiness().seq, original.seq); });
test('missing/replaced trigger or partial schema stays UNKNOWN and registration does not rebuild it', async (t) => { const f = await fixture(t), a = f.ids[0]; f.lib.patch(a, { note: 'A' }); f.lib.db.exec('DROP TRIGGER sg_metadata_changed_note'); assert.equal(f.m.readiness().code, 'METADATA_SCHEMA_UNKNOWN'); assert.equal(f.m.field(a, 'note').known, false); assert.throws(() => f.m.register(), { code: 'METADATA_SCHEMA_UNKNOWN' }); assert.equal(f.lib.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='sg_metadata_changed_note'").get().n, 0); });
test('actual Tags rename/remove/apply use fresh transactional arrays and field evidence, retain unrelated tags', async (t) => { const f = await fixture(t), a = f.ids[0], tags = new Tags(f.lib).init(), one = tags.create({ name: 'one' }), two = tags.create({ name: 'two' }); tags.apply({ action: 'add', ids: [a], tagId: one.id }); const seq = f.m.field(a, 'tags').seq; f.lib.patch(a, { tags: ['one', 'concurrent'] }); tags.apply({ action: 'add', ids: [a], tagId: two.id }); assert.deepEqual(f.lib.asset(a).tags, ['one', 'concurrent', 'two']); assert.ok(f.m.field(a, 'tags').seq > seq); tags.rename(one.id, { name: 'renamed' }); assert.deepEqual(f.lib.asset(a).tags, ['renamed', 'concurrent', 'two']); assert.equal(f.m.field(a, 'tags').known, true); tags.remove(two.id); assert.deepEqual(f.lib.asset(a).tags, ['renamed', 'concurrent']); assert.equal(f.m.field(a, 'tags').known, true); });
test('actual metadata batch apply/undo records new user order and immutable audit facts; outer fault rolls all back', async (t) => { const f = await fixture(t), a = f.ids[0], batches = new MetadataBatches(f.lib).init(), plan = batches.preview({ selection: { ids: [a] }, changes: { note: { text: 'batch', mode: 'replace' }, addTags: ['batch-tag'] } }).plan; await batches.apply(plan); const after = f.m.field(a, 'note'), audit = batches.read(plan.id); assert.equal(after.known, true); await batches.undo(plan.id); assert.equal(f.lib.asset(a).note, ''); assert.ok(f.m.field(a, 'note').seq > after.seq); assert.deepEqual(batches.read(plan.id).items[0].before, audit.items[0].before); assert.deepEqual(batches.read(plan.id).items[0].after, audit.items[0].after); assert.ok(f.effects.every(e => !e.inTransaction)); });
test('directory system clears confirmed with no new manual seq; same-value import invalidates old evidence; manifest keeps confirmed and capture source', async (t) => { const f = await fixture(t), a = f.ids[0]; f.lib.patch(a, { confirmed: true, note: 'kept', capturedAt: '2026-10-20T12:00' }); const seq = f.m.readiness().seq; f.lib.db.prepare('UPDATE assets SET path=? WHERE id=?').run(path.join(f.root.path, '待确认', 'a.wav'), a); f.lib.directoryClassification.sync(f.root.id, a); assert.equal(f.lib.asset(a).confirmed, 0); assert.equal(f.m.field(a, 'confirmed').known, false); assert.equal(f.m.readiness().seq, seq); const entry = entryFromAsset({ ...f.lib.asset(a), rel_path: '类别/a.wav' }), meta = metaFromEntry(entry); assert.equal(meta.confirmed, 0); assert.equal(meta.capture_source, '手动校正（北京时间）'); f.m.edit(a, () => f.lib.db.prepare('UPDATE assets SET note=note WHERE id=?').run(a), { source: 'import', forceUnknown: true }); assert.equal(f.m.field(a, 'note').known, false); assert.equal(f.m.readiness().seq, seq); });
test('legacy mode and MySQL never offer automatic latest; static migration types remain bounded', async (t) => { const f = await fixture(t, { register: false, directory: false }); assert.equal(f.m.readiness().code, 'METADATA_LEGACY_MODE_UNSUPPORTED'); assert.throws(() => f.m.register(), { code: 'METADATA_LEGACY_MODE_UNSUPPORTED' }); f.lib.patch(f.ids[0], { note: 'legacy keeps working' }); assert.equal(f.m.field(f.ids[0], 'note').known, false); assert.equal(mysqlColumnType('asset_metadata_fields', { name: 'asset_id' }), 'VARCHAR(36)'); assert.equal(mysqlColumnType('asset_metadata_fields', { name: 'field' }), 'VARCHAR(24)'); assert.equal(mysqlColumnType('asset_metadata_fields', { name: 'value_sha256' }), 'CHAR(64)'); });
test('actual tag edit holds SQLite writer ownership before reading arrays; concurrent second connection cannot overwrite', async (t) => { const f = await fixture(t), a = f.ids[0], tags = new Tags(f.lib).init(), tag = tags.create({ name: 'new' }); f.lib.patch(a, { tags: ['original'] }); const other = new Database(f.lib.db.name, { timeout: 0 }); t.after(() => other.close()); const asset = f.lib.asset.bind(f.lib); let attempted = false; f.lib.asset = id => { const value = asset(id); if (!attempted) {
    attempted = true;
    assert.equal(f.lib.db.inTransaction, true);
    assert.throws(() => other.prepare('UPDATE assets SET tags=? WHERE id=?').run('["racing"]', a), { code: 'SQLITE_BUSY' });
} return value; }; tags.apply({ action: 'add', ids: [a], tagId: tag.id }); assert.equal(attempted, true); assert.deepEqual(asset(a).tags, ['original', 'new']); assert.equal(f.m.field(a, 'tags').known, true); });
test('tag registry fault rolls actual asset writes/evidence/clock/effects back together', async (t) => { const f = await fixture(t), a = f.ids[0], tags = new Tags(f.lib).init(), tag = tags.create({ name: 'old' }); tags.apply({ action: 'add', ids: [a], tagId: tag.id }); const evidence = f.m.field(a, 'tags'), seq = f.m.readiness().seq, prepare = f.lib.db.prepare.bind(f.lib.db); f.effects.length = 0; f.lib.db.prepare = sql => { const statement = prepare(sql); if (sql === 'UPDATE asset_tags SET name=? WHERE id=?')
    statement.run = () => { throw Error('controlled registry write failure'); }; return statement; }; try {
    assert.throws(() => tags.rename(tag.id, { name: 'new' }), /controlled/);
}
finally {
    f.lib.db.prepare = prepare;
} assert.deepEqual(f.lib.asset(a).tags, ['old']); assert.deepEqual(f.m.field(a, 'tags'), evidence); assert.equal(f.m.readiness().seq, seq); assert.deepEqual(f.effects, []); });
test('explicit registration DDL fault rolls back completely; externally partial schema is preserved UNKNOWN', async (t) => { const f = await fixture(t, { register: false }), exec = f.lib.db.exec.bind(f.lib.db); f.lib.db.exec = sql => { if (sql.includes('CREATE TRIGGER sg_metadata_changed_confirmed'))
    throw Error('controlled DDL failure'); return exec(sql); }; try {
    assert.throws(() => f.m.register(), /controlled DDL/);
}
finally {
    f.lib.db.exec = exec;
} assert.equal(f.lib.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'asset_metadata_%' OR name LIKE 'sg_metadata_%'").get().n, 0); assert.equal(f.m.readiness().code, 'METADATA_NOT_REGISTERED'); f.lib.db.exec('CREATE TABLE asset_metadata_clock(partial TEXT)'); assert.equal(f.m.readiness().code, 'METADATA_SCHEMA_UNKNOWN'); assert.throws(() => f.m.register(), { code: 'METADATA_SCHEMA_UNKNOWN' }); assert.deepEqual(f.lib.db.prepare('PRAGMA table_info(asset_metadata_clock)').all().map(r => r.name), ['partial']); });
test('clock overflow cannot commit a field or lose its old evidence; mismatched domain/digest remain unknown', async (t) => { const f = await fixture(t), a = f.ids[0]; f.lib.patch(a, { note: 'original' }); const original = f.m.field(a, 'note'); f.lib.db.prepare('UPDATE asset_metadata_clock SET seq=?').run(Number.MAX_SAFE_INTEGER); assert.throws(() => f.lib.patch(a, { note: 'overflow' }), { code: 'METADATA_CLOCK_OVERFLOW' }); assert.equal(f.lib.asset(a).note, 'original'); assert.deepEqual(f.m.field(a, 'note'), original); f.lib.db.prepare('UPDATE asset_metadata_clock SET domain_id=?').run(crypto.randomUUID()); assert.equal(f.m.field(a, 'note').known, false); });
test('post-commit notification failure explicitly reports committed=true and cannot roll back saved evidence', async (t) => { const f = await fixture(t), a = f.ids[0]; f.lib.onMetadataChanged = () => { throw Error('controlled notification failure'); }; let error; try {
    f.lib.patch(a, { note: 'saved', capturedAt: '' });
}
catch (e) {
    error = e;
} assert.equal(error?.code, 'METADATA_POST_COMMIT_FAILED'); assert.equal(error.committed, true); assert.equal(f.lib.asset(a).note, 'saved'); assert.equal(f.m.field(a, 'note').known, true); assert.ok(f.effects.some(e => e.kind === 'enqueue' && !e.inTransaction)); });
test('actual probe is a system capture change, never a new user edit; physical-only SQL preserves unrelated field clocks', async (t) => { const f = await fixture(t), a = f.ids[0]; f.lib.patch(a, { note: 'kept', capturedAt: '2026-10-20T12:00' }); const original = f.m.field(a, 'note'), seq = f.m.readiness().seq; f.lib.db.prepare("UPDATE assets SET capture_source='',capture_status='pending' WHERE id=?").run(a); await f.lib.probe(a); assert.deepEqual(f.m.field(a, 'note'), original); assert.equal(f.lib.asset(a).captured_ms, null); assert.equal(f.m.field(a, 'capture').known, false); assert.equal(f.m.readiness().seq, seq); f.lib.db.prepare('UPDATE assets SET file_checked_ms=file_checked_ms+1 WHERE id=?').run(a); assert.deepEqual(f.m.field(a, 'note'), original); });
test('actual manifest import keeps false/empty/capture source and invalidates same-valued user evidence without editing batch audit', async (t) => { const f = await fixture(t), a = f.ids[0]; f.lib.patch(a, { note: 'current', favorite: true, confirmed: true, capturedAt: '2026-10-20T12:00' }); const first = await readManifest(f.root); first.manifest.entries[a] = { ...first.manifest.entries[a], note: '', favorite: false, confirmed: false, capturedMs: null, captureSource: '' }; await writeManifest(f.root, first.manifest); await reconcileRoot(f.lib, f.root, { ...options, importMetadata: true }); const asset = f.lib.asset(a); assert.equal(asset.note, ''); assert.equal(asset.favorite, 0); assert.equal(asset.confirmed, 0); assert.equal(asset.captured_ms, null); assert.equal(asset.capture_source, ''); for (const field of ['note', 'favorite', 'confirmed', 'capture'])
    assert.equal(f.m.field(a, field).known, false); });
// Synthetic cloud DTO/stream fixture copied from existing cloud-audio-service test;
// no original setup/teardown or filesystem inventory is executed.
function wavBytes(seed = 1, length = 256) {
    const data = Buffer.alloc(length, seed);
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(8000, 24);
    header.writeUInt32LE(16000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
}
const sha = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
function makeCloud() {
    const bytes = wavBytes(11);
    const audioId = crypto.randomUUID();
    const shareId = crypto.randomUUID();
    const secondShareId = crypto.randomUUID();
    const cloud = {
        epoch: 4,
        loggedIn: true,
        accountId: "account-a",
        deviceId: "device-a",
        bytes,
        audioId,
        shareId,
        secondShareId,
        mediaKind: "SFX",
        calls: { catalog: 0, details: 0, stream: 0, writes: [] },
        flags: { noShares: false, emptyCatalog: false, wrongBytes: null, truncate: false, streamGate: null, detailGate: null },
        getState() {
            return {
                configured: true,
                state: this.loggedIn ? "logged-in" : "needs-login",
                accountId: this.accountId,
                deviceId: this.deviceId,
                originHost: "mock.local",
            };
        },
        async forgetSession() {
            this.epoch += 1;
        },
        async proxy(method, pathname, options = {}) {
            if (method !== "GET") {
                // 写请求：记录方法与 body 供断言；云端 revoke 成功体为 null。
                this.calls.writes.push({ method, pathname, body: options.body ?? null, epoch: options.epoch });
                if (this.flags.writeError)
                    throw this.flags.writeError;
                return null;
            }
            if (pathname.startsWith("/media/audio/catalog")) {
                this.calls.catalog += 1;
                if (this.flags.emptyCatalog)
                    return { items: [], hasMore: false };
                return {
                    items: [{
                            id: this.audioId,
                            sha256: sha(this.bytes),
                            bytes: this.bytes.length,
                            contentType: "audio/wav",
                            createdAt: "2026-10-24T00:00:00Z",
                            preferredShareId: this.shareId,
                            ownerAccountId: "owner-a",
                            fileName: "环境音.wav",
                            mediaKind: this.mediaKind,
                            category: "音效",
                            subcategory: "环境",
                            visibleShareCount: 2,
                        }],
                    hasMore: false,
                };
            }
            this.calls.details += 1;
            if (this.flags.detailGate && this.calls.details >= 2)
                await this.flags.detailGate.promise;
            const shares = this.flags.noShares ? [] : [
                {
                    id: this.shareId,
                    ownerAccountId: "owner-a",
                    fileName: "环境音.wav",
                    mediaKind: this.mediaKind,
                    category: "音效",
                    subcategory: "环境",
                    createdAt: "2026-10-24T00:00:00Z",
                    version: 0,
                },
                {
                    id: this.secondShareId,
                    ownerAccountId: "owner-b",
                    fileName: "另一个名字.wav",
                    mediaKind: this.mediaKind,
                    category: "音效",
                    subcategory: "环境",
                    createdAt: "2026-10-23T00:00:00Z",
                    version: 1,
                },
            ];
            return {
                audio: {
                    id: this.audioId,
                    sha256: sha(this.bytes),
                    bytes: this.bytes.length,
                    contentType: "audio/wav",
                    createdAt: "2026-10-24T00:00:00Z",
                },
                shares,
            };
        },
        async openAudioContentStream(audioId, { signal }) {
            this.calls.stream += 1;
            assert.equal(audioId, this.audioId);
            const payload = this.flags.wrongBytes || this.bytes;
            const declared = this.flags.truncate ? payload.length + 10 : payload.length;
            const gate = this.flags.streamGate;
            const body = new Readable({
                read() {
                    if (this.started)
                        return;
                    this.started = true;
                    this.push(payload.subarray(0, Math.max(1, Math.floor(payload.length / 2))));
                    const finish = () => {
                        if (!this.destroyed)
                            this.push(payload.subarray(Math.max(1, Math.floor(payload.length / 2))));
                        if (!this.destroyed)
                            this.push(null);
                    };
                    if (gate)
                        gate.promise.then(finish);
                    else
                        setTimeout(finish, 1);
                },
            });
            body.on("close", () => { this.bodyClosed = true; });
            signal?.addEventListener("abort", () => body.destroy(), { once: true });
            return {
                status: 200,
                headers: { "content-type": "audio/wav", "content-length": String(declared) },
                body,
            };
        },
    };
    return cloud;
}
test('real cloud download automatic kind writer uses system provenance and creates no human field sequence', { timeout: 15000 }, async (t) => { const f = await fixture(t), cloud = makeCloud(); cloud.mediaKind = 'MUSIC'; const folder = path.join(f.base, 'mixed'); await fs.mkdir(folder); const root = await f.lib.addRoot(folder, 'mixed'), calls = [], patch = f.lib.patch.bind(f.lib); f.lib.patch = (id, body, options) => { calls.push({ id, body, options }); return patch(id, body, options); }; const service = await new CloudAudioService(f.lib, { dataDir: f.lib.dataDir, cloudAuth: cloud, enabled: true }).init(); t.after(() => service.dispose()); const job = await service.startDownload({ audioId: cloud.audioId, shareId: cloud.shareId, rootId: root.id }); const deadline = Date.now() + 10000; let current; do {
    current = service.getJob(job.id);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(current.state))
        break;
    assert.ok(Date.now() < deadline, 'actual private download settles');
    await new Promise(r => setTimeout(r, 10));
} while (true); assert.equal(current.state, 'completed', JSON.stringify(current)); assert.equal(f.lib.asset(current.assetId).kind, 'music'); assert.ok(calls.some(c => c.body.kind === 'music' && c.options.source === 'system')); assert.equal(f.m.readiness().seq, 0); assert.equal(f.m.field(current.assetId, 'note').known, false); await service.dispose(); });
test('actual legacy category writers preserve normal behavior while explicitly denying automatic latest', async (t) => { const f = await fixture(t, { register: false, directory: false }), a = f.ids[0], categories = new AssetCategories(f.lib).init(), parent = categories.create({ name: 'old' }), sub = categories.createSubcategory({ categoryId: parent.id, name: 'one' }); categories.assign({ ids: [a], categoryId: parent.id }); categories.save({ assetId: a, category: 'old', sub: 'one', extraIds: [] }); assert.equal(f.lib.asset(a).sub, 'one'); categories.rename(parent.id, { name: 'renamed' }); categories.renameSubcategory(sub.id, { name: 'two' }); assert.equal(f.lib.asset(a).category, 'renamed'); assert.equal(f.lib.asset(a).sub, 'two'); categories.removeSubcategory(sub.id); assert.equal(f.lib.asset(a).sub, ''); categories.detach({ assetId: a, categoryId: parent.id }); assert.equal(f.lib.asset(a).category, ''); assert.equal(f.m.field(a, 'note').code, 'METADATA_LEGACY_MODE_UNSUPPORTED'); });
test('real scan invalidates automatic capture clear; actual manifest sync exports current metadata without new edits', async (t) => { const f = await fixture(t), a = f.ids[0]; f.lib.patch(a, { note: 'kept', capturedAt: '2026-10-20T12:00' }); f.lib.db.prepare("UPDATE assets SET capture_source='自动提取' WHERE id=?").run(a); const seq = f.m.readiness().seq, note = f.m.field(a, 'note'); await fs.appendFile(f.lib.asset(a).path, 'more synthetic bytes'); const job = f.lib.scan(f.root.id), deadline = Date.now() + 5000; while (job.status === 'running') {
    assert.ok(Date.now() < deadline);
    await new Promise(r => setTimeout(r, 5));
} assert.equal(job.status, 'done'); assert.equal(f.lib.asset(a).captured_ms, null); assert.equal(f.m.field(a, 'capture').known, false); assert.deepEqual(f.m.field(a, 'note'), note); const sync = createManifestSync(f.lib, { debounceMs: 60000 }); t.after(() => sync.stop()); sync.touch(f.root.id); sync.stop(); await sync.flush(); sync.stop(); const manifest = await readManifest(f.root); assert.equal(manifest.manifest.entries[a].note, 'kept'); assert.equal(manifest.manifest.entries[a].captureSource, ''); assert.equal(f.m.readiness().seq, seq); });
test('unregistered actual batch and tags still work with no implicit evidence DDL', async (t) => { const f = await fixture(t, { register: false }), a = f.ids[0], tags = new Tags(f.lib).init(), tag = tags.create({ name: 'ordinary' }); tags.apply({ action: 'add', ids: [a], tagId: tag.id }); const batches = new MetadataBatches(f.lib).init(), plan = batches.preview({ selection: { ids: [a] }, changes: { note: { text: 'ordinary', mode: 'replace' } } }).plan; await batches.apply(plan); await batches.undo(plan.id); assert.equal(f.lib.asset(a).note, ''); assert.deepEqual(f.lib.asset(a).tags, ['ordinary']); assert.equal(f.lib.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'asset_metadata_%' OR name LIKE 'sg_metadata_%'").get().n, 0); });
test('old manifest missing capture source does not invent a user edit; actual missing-row recovery is unknown', async (t) => { const f = await fixture(t), a = f.ids[0]; f.lib.patch(a, { note: 'archived', favorite: true, confirmed: true }); const sync = createManifestSync(f.lib, { debounceMs: 60000 }); t.after(() => sync.stop()); sync.touch(f.root.id); sync.stop(); await sync.flush(); sync.stop(); const seq = f.m.readiness().seq; f.lib.db.prepare('DELETE FROM assets WHERE id=?').run(a); await reconcileRoot(f.lib, f.root, options); assert.equal(f.lib.asset(a).note, 'archived'); assert.equal(f.lib.asset(a).favorite, 1); assert.equal(f.lib.asset(a).confirmed, 1); assert.equal(f.m.field(a, 'note').known, false); assert.equal(f.m.readiness().seq, seq); assert.equal(metaFromEntry({ capturedMs: null }).capture_source, undefined); });
test('whole registration is bound to the real database file; copied evidence and unsupported engine are unknown', async (t) => { const f = await fixture(t), copy = path.join(f.base, 'copy.sqlite'); f.lib.patch(f.ids[0], { note: 'A' }); await f.lib.db.backup(copy); const db = new Database(copy), other = await new Library(path.join(f.base, 'copy-data'), { database: db, directoryClassification: true }).init(); t.after(() => db.close()); assert.equal(other.metadataVersions.readiness().code, 'METADATA_BINDING_UNKNOWN'); assert.equal(other.metadataVersions.field(f.ids[0], 'note').known, false); const originalKind = f.lib.db.kind; f.lib.db.kind = 'mysql'; assert.equal(f.m.readiness().code, 'METADATA_ENGINE_UNSUPPORTED'); f.lib.db.kind = originalKind; });
test('replaced trigger SQL is rejected, not only missing trigger; raw external transaction is refused before patch writes', async (t) => { const f = await fixture(t), a = f.ids[0]; f.lib.patch(a, { note: 'A' }); f.lib.db.exec('DROP TRIGGER sg_metadata_changed_note; CREATE TRIGGER sg_metadata_changed_note AFTER UPDATE OF note ON assets BEGIN SELECT 1; END'); assert.equal(f.m.readiness().code, 'METADATA_SCHEMA_UNKNOWN'); assert.equal(f.m.field(a, 'note').known, false); assert.throws(() => f.m.register(), { code: 'METADATA_SCHEMA_UNKNOWN' }); f.lib.db.exec('BEGIN'); try {
    assert.throws(() => f.lib.patch(a, { note: 'raw transaction' }), { code: 'UNOBSERVED_TRANSACTION' });
    assert.equal(f.lib.asset(a).note, 'A');
}
finally {
    f.lib.db.exec('ROLLBACK');
} });
test('actual live-row manifest adoption invalidates a new ID field clock instead of assigning restored values a new sequence',async t=>{const f=await fixture(t),a=f.ids[0],old=f.lib.db.prepare('SELECT * FROM assets WHERE id=?').get(a),live=crypto.randomUUID();f.lib.db.prepare('DELETE FROM assets WHERE id=?').run(a);const row={...old,id:live},keys=Object.keys(row);f.lib.db.prepare('INSERT INTO assets('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')').run(...keys.map(k=>row[k]));f.lib.patch(live,{note:'new live metadata'});const seq=f.m.readiness().seq;await reconcileRoot(f.lib,f.root,options);assert.equal(f.lib.asset(live).note,'');assert.equal(f.m.field(live,'note').known,false);assert.equal(f.m.readiness().seq,seq);});
test('field evidence insert fault rolls actual patch/clock/effects back, not just the helper return value',async t=>{const f=await fixture(t),a=f.ids[0];f.lib.patch(a,{note:'before'});const before=f.m.field(a,'note'),seq=f.m.readiness().seq,prepare=f.lib.db.prepare.bind(f.lib.db);f.effects.length=0;f.lib.db.prepare=sql=>{const stmt=prepare(sql);if(sql.startsWith('INSERT INTO asset_metadata_fields('))stmt.run=()=>{throw Error('controlled field evidence write failure');};return stmt;};try{assert.throws(()=>f.lib.patch(a,{note:'must roll back',capturedAt:''}),/controlled field evidence/);}finally{f.lib.db.prepare=prepare;}assert.equal(f.lib.asset(a).note,'before');assert.deepEqual(f.m.field(a,'note'),before);assert.equal(f.m.readiness().seq,seq);assert.deepEqual(f.effects,[]);});
test('wall clock reversal cannot reverse user modification order',async t=>{const f=await fixture(t),[a,b]=f.ids,now=Date.now;f.lib.patch(a,{note:'first'});const first=f.m.field(a,'note');try{Date.now=()=>1;f.lib.patch(b,{note:'second'});}finally{Date.now=now;}assert.ok(f.m.field(b,'note').seq>first.seq);assert.ok(f.lib.db.prepare('SELECT modified_ms n FROM asset_metadata_fields WHERE asset_id=? AND field=?').get(b,'note').n<f.lib.db.prepare('SELECT modified_ms n FROM asset_metadata_fields WHERE asset_id=? AND field=?').get(a,'note').n);});
test('unsupported-engine branch reuses observed outer transaction, never starts nested transactions; SQLite-backed branch test only',async t=>{const f=await fixture(t,{register:false}),a=f.ids[0],transaction=f.lib.db.transaction.bind(f.lib.db),oldKind=f.lib.db.kind;let starts=0;f.effects.length=0;f.lib.db.transaction=fn=>{starts++;return transaction(fn);};f.lib.db.kind='mysql';try{f.m.transaction(()=>{f.lib.patch(a,{note:'outer preserved',capturedAt:''});assert.deepEqual(f.effects,[]);});assert.equal(starts,1);assert.equal(f.lib.asset(a).note,'outer preserved');assert.equal(f.m.field(a,'note').known,false);assert.ok(f.effects.every(e=>!e.inTransaction));}finally{f.lib.db.kind=oldKind;f.lib.db.transaction=transaction;}});
