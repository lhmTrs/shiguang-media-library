import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
// Exact private dependency copy, not current A/B candidates. No scan/media reads.
import { Library } from '../server/library.mjs';
import { createCloudUploadScopeProvider, SCOPE_PROVIDER_LIMITS as L } from '../server/cloud-upload-scope-provider.mjs';

const registrations = [];
const proofGeneration = 'c0000000-0000-4000-8000-000000000001';
const controlledProof = request => ({ known: true, complete: true, generation: proofGeneration, ...request,
    completed: request.rootVector.map(r => ({ rootId: r.rootId, coverage: 'FULL', errors: 0, scanCompletedAt: 123 })) });
async function fixture(t, count = 3) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'uq04b3-'));
    registrations.push({ directory: dir, policy: 'RETAIN_ALL', atSetup: true });
    const lib = await new Library(path.join(dir, 'data'), { directoryClassification: true }).init();
    t.after(() => lib.db.close());
    const roots = [];
    for (let i = 0; i < count; i++) {
        const folder = path.join(dir, `private-root-${i}`); await fs.mkdir(folder);
        const r = await lib.addRoot(folder, 'music');
        // Real index rows seeded in a private SQLite library. No claim of scan completion/media existence.
        lib.db.prepare('UPDATE roots SET name=?,revision=7,reconciled_ms=100 WHERE id=?').run('同名根', r.id);
        roots.push(lib.rootById(r.id));
        addAsset(lib, r, `id-${i}.wav`, '类别', '子类');
    }
    lib.repairIndexReaders = 0; // Explicit controlled activity state, not inferred from initialization.
    return { lib, dir, roots };
}
function addAsset(lib, root, name, category = '类别', sub = '子类') {
    const id = randomUUID();
    lib.db.prepare("INSERT INTO assets(id,root_id,path,name,kind,category,sub,online,trashed) VALUES(?,?,?,?,?,?,?,1,0)")
        .run(id, root.id, path.join(root.path, category, sub, name), name, 'music', category, sub);
    return id;
}
function choose(provider, roots, options = {}) {
    const page = provider.listCategories({ rootIds: roots.map(r => r.id), ...options });
    return { binding: page.binding, scopes: [{ rootId: roots[0].id, category: '类别', subcategory: '子类' }] };
}
test.after(() => console.log('UQ04B3_RESOURCES=' + JSON.stringify({ roots: registrations, after: 'All setup roots retained; known DB handles close only; no scan/hash/after FS inventory/deletion' })));

test('constructor and projections are read-only on real Library/SQLite, only safe DTO fields and stable IDs', async t => {
    const { lib, roots, dir } = await fixture(t);
    const originalPrepare = lib.db.prepare.bind(lib.db), sql = [];
    lib.db.prepare = query => { sql.push(query); return originalPrepare(query); };
    const changes = originalPrepare('SELECT total_changes() n').get().n;
    lib.db.pragma('query_only=ON');
    const provider = createCloudUploadScopeProvider(lib); assert.equal(sql.length, 0);
    for (const method of ['scan', 'source', 'roots', 'allRoots', 'init']) lib[method] = () => { throw Error('UNEXPECTED_LIBRARY_WORK'); };
    lib.directoryClassification.options = () => { throw Error('UNBOUNDED_PATH_LEAKING_OPTIONS'); };
    const page = provider.listRoots(); assert.equal(page.rows.length, 3);
    for (const row of page.rows) { assert.deepEqual(Object.keys(row), ['rootId', 'name', 'kind', 'online']); assert.ok(roots.some(r => r.id === row.rootId)); }
    const categories = provider.listCategories({ rootIds: [roots[0].id] });
    assert.deepEqual(categories.rows.map(row => [row.category, row.subcategory]), [['类别', '子类'], ['类别', undefined]]);
    assert.equal(JSON.stringify({ page, categories }).includes(dir), false);
    assert.equal(JSON.stringify({ page, categories }).includes('path'), false);
    assert.ok(sql.every(q => q.startsWith('SELECT '))); assert.equal(originalPrepare('SELECT total_changes() n').get().n, changes);
    assert.equal(originalPrepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'cloud_upload%'").get().n, 0);
});

test('bounded cursors page all roots without ID collisions, reject parameter changes, forgery, expiry and other provider', async t => {
    const { lib } = await fixture(t, 4); let now = 10;
    const provider = createCloudUploadScopeProvider(lib, { now: () => now });
    let page = provider.listRoots({ limit: 1 }), cursor = page.nextCursor, ids = page.rows.map(r => r.rootId);
    assert.throws(() => provider.listRoots({ limit: 2, cursor }), { code: 'SCOPE_CURSOR_INVALID' });
    assert.throws(() => provider.listRoots({ limit: 1, cursor: randomUUID() }), { code: 'SCOPE_CURSOR_INVALID' });
    assert.throws(() => createCloudUploadScopeProvider(lib).listRoots({ limit: 1, cursor }), { code: 'SCOPE_CURSOR_INVALID' });
    while (page.hasMore) { page = provider.listRoots({ limit: 1, cursor: page.nextCursor }); ids.push(...page.rows.map(r => r.rootId)); }
    assert.equal(new Set(ids).size, 4); assert.equal(page.nextCursor, null);
    now += L.ttlMs; assert.throws(() => provider.listRoots({ limit: 1, cursor }), { code: 'SCOPE_CURSOR_INVALID' });
    now = 1; assert.throws(() => provider.listRoots({ limit: 1 }), { code: 'SCOPE_NOT_READY' });
});

test('category pagination distinguishes whole category from exact empty subcategory and cannot cross roots', async t => {
    const { lib, roots } = await fixture(t, 2); addAsset(lib, roots[0], 'loose.wav', '类别', '');
    const provider = createCloudUploadScopeProvider(lib), input = { rootIds: [roots[0].id], limit: 1 };
    let page = provider.listCategories(input), all = [...page.rows];
    const cursor = page.nextCursor;
    assert.throws(() => provider.listCategories({ ...input, rootIds: [roots[1].id], cursor }), { code: 'SCOPE_CURSOR_INVALID' });
    while (page.hasMore) { page = provider.listCategories({ ...input, cursor: page.nextCursor }); all.push(...page.rows); }
    assert.equal(all.length, 3); assert.equal(new Set(all.map(s => JSON.stringify(s))).size, 3);
    assert.ok(all.some(s => s.subcategory === '')); assert.ok(all.some(s => !Object.hasOwn(s, 'subcategory')));
});

test('retirement, root relocation/revision and category/membership changes invalidate frozen selection without scope expansion', async t => {
    for (const change of ['retire', 'revision', 'path', 'category', 'membership']) {
        const { lib, roots } = await fixture(t, 1), provider = createCloudUploadScopeProvider(lib), selected = choose(provider, roots);
        if (change === 'retire') lib.retireRoot(roots[0].id);
        if (change === 'revision') lib.db.prepare('UPDATE roots SET revision=revision+1').run();
        if (change === 'path') lib.db.prepare('UPDATE roots SET path=?').run(path.join(roots[0].path, 'relocated'));
        if (change === 'category') {
            lib.db.prepare('UPDATE assets SET path=?').run(path.join(roots[0].path, '新类', '新子类', 'x.wav'));
            lib.directoryClassification.sync(roots[0].id);
        }
        if (change === 'membership') addAsset(lib, roots[0], 'new.wav');
        await assert.rejects(provider.prepareSelection(selected), { code: 'SCOPE_CHANGED' });
    }
});

test('timestamps, online and completed in-memory scan job alone remain UNPROVEN; actual gates stay fail-closed', async t => {
    const { lib, roots } = await fixture(t, 1), provider = createCloudUploadScopeProvider(lib), selected = choose(provider, roots);
    lib.jobs.set('old-scan', { type: 'scan', rootId: roots[0].id, status: 'done', errors: [], finishedAt: 100 });
    let state = await provider.prepareSelection(selected); assert.equal(state.scanComplete, false); assert.equal(state.missing[0], 'FULL_SCAN_PROOF_READER_MISSING');
    for (const gate of ['readers-unknown', 'readers-busy', 'locks', 'job', 'job-unknown']) {
        const previous = lib.repairIndexReaders;
        if (gate === 'readers-unknown') delete lib.repairIndexReaders;
        if (gate === 'readers-busy') lib.repairIndexReaders = 1;
        if (gate === 'locks') lib.locks.add('controlled');
        if (gate === 'job') lib.jobs.set('live', { status: 'running' });
        if (gate === 'job-unknown') lib.jobs.set('live', { status: 'unrecognized' });
        state = await provider.prepareSelection(selected); assert.equal(state.state, 'UNPROVEN'); assert.match(state.missing[0], /^ACTIVITY_/);
        lib.repairIndexReaders = previous; lib.locks.clear(); lib.jobs.delete('live');
    }
    lib.db.prepare('UPDATE roots SET online=0').run(); const offline = choose(provider, roots);
    assert.equal((await provider.prepareSelection(offline)).missing[0], 'ROOT_OFFLINE');
});

test('controlled trusted reader must prove exact multiple-root vector and scopes twice; this is not real host readiness', async t => {
    const { lib, roots, dir } = await fixture(t, 2); let calls = 0;
    const provider = createCloudUploadScopeProvider(lib, { readCompletion: async request => { calls++; assert.equal(JSON.stringify(request).includes(dir), false); return controlledProof(request); } });
    const selected = choose(provider, roots); selected.scopes.push({ rootId: roots[1].id });
    const result = await provider.prepareSelection(selected);
    assert.equal(calls, 2); assert.equal(result.state, 'PROVEN'); assert.equal(result.scanComplete, true); assert.equal(result.rootVector.length, 2);
    assert.equal(Object.hasOwn(result, 'rootRevision'), false); assert.equal(JSON.stringify(result).includes(dir), false);
    await assert.rejects(provider.prepareSelection({ ...selected, scopes: [{ rootId: randomUUID() }] }), { code: 'SCOPE_CHANGED' });
    await assert.rejects(provider.prepareSelection({ ...selected, scopes: [{ rootId: roots[0].id, category: '类别', subcategory: '不存在' }] }), { code: 'SCOPE_CHANGED' });
    await assert.rejects(provider.prepareSelection({ ...selected, path: dir }), { code: 'INVALID_REQUEST' });
});

test('unknown/partial/mismatched/throwing/unstable proof and path-bearing evidence cannot establish readiness', async t => {
    const { lib, roots } = await fixture(t, 1);
    for (const variant of ['unknown', 'partial', 'errors', 'vector', 'scopes', 'throws', 'generation', 'path']) {
        let calls = 0;
        const provider = createCloudUploadScopeProvider(lib, { readCompletion: async request => {
            calls++; const proof = controlledProof(request);
            if (variant === 'unknown') proof.known = false;
            if (variant === 'partial') proof.completed[0].coverage = 'PARTIAL';
            if (variant === 'errors') proof.completed[0].errors = 1;
            if (variant === 'vector') proof.rootVector[0].revision++;
            if (variant === 'scopes') proof.scopes = [];
            if (variant === 'throws') throw Error('private path must not leak');
            if (variant === 'generation' && calls === 2) proof.generation = randomUUID();
            if (variant === 'path') proof.completed[0].path = '/private/hidden';
            return proof;
        } });
        const result = await provider.prepareSelection(choose(provider, roots));
        assert.equal(result.state, 'UNPROVEN', variant); assert.equal(result.code, 'SCOPE_NOT_READY');
        assert.equal(JSON.stringify(result).includes('hidden'), false);
    }
});

test('actual index mutation or activity during reader await is rechecked before any PROVEN result', async t => {
    for (const variant of ['category', 'retire', 'busy', 'db', 'expiry']) {
        const { lib, roots } = await fixture(t, 1); let calls = 0, now = 1, replaced;
        const provider = createCloudUploadScopeProvider(lib, { now: () => now, readCompletion: async request => {
            if (++calls === 2) {
                if (variant === 'category') lib.db.prepare("UPDATE assets SET category='变化'").run();
                if (variant === 'retire') lib.retireRoot(roots[0].id);
                if (variant === 'busy') lib.repairIndexReaders = 1;
                if (variant === 'db') { replaced = lib.db; lib.db = {}; }
                if (variant === 'expiry') now += L.ttlMs;
            }
            return controlledProof(request);
        } });
        const selected = choose(provider, roots);
        try {
            if (variant === 'busy') assert.equal((await provider.prepareSelection(selected)).state, 'UNPROVEN');
            else await assert.rejects(provider.prepareSelection(selected), { code: variant === 'db' ? 'SCOPE_NOT_READY' : variant === 'expiry' ? 'SCOPE_CURSOR_INVALID' : 'SCOPE_CHANGED' });
        } finally { if (replaced) lib.db = replaced; }
    }
});

test('real SQLite 5000 items are not truncated, 5001 rejects; page rows/bytes/token budgets cannot be raised', async t => {
    const { lib, roots } = await fixture(t, 1), provider = createCloudUploadScopeProvider(lib);
    lib.db.transaction(() => { for (let i = 1; i < 5000; i++) addAsset(lib, roots[0], `generated-${i}.wav`); })();
    const selected = choose(provider, roots); assert.equal((await provider.prepareSelection(selected)).state, 'UNPROVEN');
    addAsset(lib, roots[0], 'one-too-many.wav');
    assert.throws(() => provider.listCategories({ rootIds: [roots[0].id] }), { code: 'ITEM_LIMIT' });
    assert.throws(() => provider.listRoots({ limit: 101 }), { code: 'INVALID_REQUEST' });
    assert.throws(() => provider.listRoots({ maxBytes: 65537 }), { code: 'INVALID_REQUEST' });
    assert.throws(() => provider.listRoots({ maxBytes: 1 }), { code: 'SCOPE_BUDGET_EXCEEDED' });
    const limited = createCloudUploadScopeProvider(lib);
    for (let i = 0; i < 128; i++) limited.listRoots();
    assert.throws(() => limited.listRoots(), { code: 'SCOPE_BUDGET_EXCEEDED' });
});

test('root row cap, unsafe metadata and category byte budget fail explicitly instead of omitting or leaking rows', async t => {
    const { lib, roots } = await fixture(t, 1), provider = createCloudUploadScopeProvider(lib);
    lib.db.prepare('UPDATE roots SET name=?').run('/private/absolute/name');
    assert.throws(() => provider.listRoots(), { code: 'SCOPE_METADATA_INVALID' });
    lib.db.prepare("UPDATE roots SET name='safe'").run();
    lib.db.prepare("UPDATE assets SET category='/private/path'").run();
    assert.throws(() => provider.listCategories({ rootIds: [roots[0].id] }), { code: 'SCOPE_METADATA_INVALID' });
    lib.db.prepare("UPDATE assets SET category='类别'").run();
    assert.throws(() => provider.listCategories({ rootIds: [roots[0].id], maxBytes: 140 }), { code: 'SCOPE_BUDGET_EXCEEDED' });
    const insert = lib.db.prepare("INSERT INTO roots(id,path,name,kind,online,retired,revision) VALUES(?,?,?,'music',1,0,0)");
    lib.db.transaction(() => { for (let i = 1; i < 5001; i++) insert.run(randomUUID(), `/controlled-index-only/${i}`, `root${i}`); })();
    assert.throws(() => provider.listRoots(), { code: 'SCOPE_BUDGET_EXCEEDED' });
});

test('root vector and categories share a real SQLite transaction snapshot across a concurrent writer', async t => {
    const { lib, roots, dir } = await fixture(t, 1), provider = createCloudUploadScopeProvider(lib);
    const writer = new Database(path.join(dir, 'data', 'library.sqlite'));
    const original = lib.db.prepare.bind(lib.db); let once = true;
    lib.db.prepare = query => {
        const statement = original(query);
        if (query.includes('FROM assets WHERE')) {
            const all = statement.all.bind(statement);
            statement.all = (...args) => {
                if (once) { once = false; writer.transaction(() => { writer.prepare('UPDATE roots SET revision=8').run(); writer.prepare("UPDATE assets SET category='并发变化'").run(); })(); }
                return all(...args);
            };
        }
        return statement;
    };
    try {
        const categories = provider.listCategories({ rootIds: [roots[0].id] });
        assert.equal(categories.rows[0].category, '类别');
        await assert.rejects(provider.prepareSelection({ binding: categories.binding, scopes: [{ rootId: roots[0].id }] }), { code: 'SCOPE_CHANGED' });
    } finally { writer.close(); lib.db.prepare = original; }
});

test('all provider methods tolerate filesystem/media/network work being forbidden and DB query_only enforced', async t => {
    const { lib, roots } = await fixture(t, 1), provider = createCloudUploadScopeProvider(lib, { readCompletion: controlledProof });
    lib.db.pragma('query_only=ON'); const saved = {}, fetch = globalThis.fetch;
    globalThis.fetch = () => { throw Error('FORBIDDEN_NETWORK'); };
    for (const method of ['open', 'stat', 'readdir', 'readFile', 'writeFile', 'mkdir']) { saved[method] = fs[method]; fs[method] = () => { throw Error('FORBIDDEN_FS_WORK'); }; }
    try {
        provider.listRoots(); const selected = choose(provider, roots);
        assert.equal((await provider.prepareSelection(selected)).state, 'PROVEN');
    } finally { for (const [method, value] of Object.entries(saved)) fs[method] = value; globalThis.fetch = fetch; }
});

test('actual serialized page byte cap and whole snapshot byte cap reject oversized projections without truncating', async t => {
    const { lib } = await fixture(t, 4), provider = createCloudUploadScopeProvider(lib);
    let page = provider.listRoots({ maxBytes: 300 }), seen = 0;
    do {
        assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 300); seen += page.rows.length;
        if (!page.hasMore) break;
        page = provider.listRoots({ maxBytes: 300, cursor: page.nextCursor });
    } while (true);
    assert.equal(seen, 4);
    const insert = lib.db.prepare("INSERT INTO roots(id,path,name,kind,online,retired,revision) VALUES(?,?,?,'music',1,0,0)");
    lib.db.transaction(() => { for (let i = 0; i < 300; i++) insert.run(randomUUID(), '/controlled-index-only/' + 'x'.repeat(3900) + i, `long${i}`); })();
    assert.throws(() => provider.listRoots(), { code: 'SCOPE_BUDGET_EXCEEDED' });
});
