import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Library } from '../server/library.mjs';
import { AssetFingerprints } from '../server/asset-fingerprints.mjs';
import { reconcileRoot, reconcilePaths } from '../server/reconcile.mjs';
import { readManifest } from '../server/fs-manifest.mjs';
const options = { tagFiles: false, hashBudgetFiles: 0, hashBudgetBytes: 0, matchHashBudgetFiles: 0 };
const registered = [];
async function setup(t, { count = 1, contents = 'original bytes', taskOptions = {} } = {}) {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sg-fingerprint-')));
    registered.push({ directory: base, policy: 'RETAIN_ALL', setup: true });
    const lib = await new Library(path.join(base, 'data'), { directoryClassification: true }).init();
    lib.enqueue = () => { };
    const roots = [];
    for (const name of ['source', 'target']) {
        const dir = path.join(base, name);
        await fs.mkdir(dir);
        roots.push(await lib.addRoot(dir, 'music'));
    }
    const files = [];
    for (let i = 0; i < count; i++) {
        const file = path.join(roots[0].path, `source-${i}.wav`);
        await fs.writeFile(file, contents);
        files.push(file);
    }
    await reconcileRoot(lib, roots[0], options);
    let tasks = new AssetFingerprints(lib, taskOptions);
    const ids = lib.db.prepare('SELECT id FROM assets ORDER BY path').all().map(a => a.id);
    const f = { base, lib, roots, files, ids, get tasks() { return tasks; }, raw(id = ids[0]) { return lib.db.prepare('SELECT * FROM assets WHERE id=?').get(id); }, async fingerprint(ids = f.ids) { const job = tasks.start({ mode: 'fingerprint', assetIds: ids }); return tasks.wait(job.taskId); }, async preview(ids = f.ids) { const job = tasks.start({ mode: 'preview', assetIds: ids, rootIds: [roots[1].id] }); return tasks.wait(job.taskId); }, setTasks(opts = {}) { tasks = new AssetFingerprints(lib, opts); return tasks; }, async reopen() { await tasks.dispose(); lib.db.close(); const Database = (await import('better-sqlite3')).default; lib.db = new Database(path.join(base, 'data', 'library.sqlite')); tasks = new AssetFingerprints(lib); } };
    t.after(async () => { await tasks.dispose(); lib.db.close(); });
    return f;
}
test.after(() => console.log(JSON.stringify({ registeredRoots: registered, after: 'only known task promises and DB handles closed; no FS scans or recursive removal' })));
test('explicit task is idle until started, saves SHA and versioned actual binding, survives DB reopen', async (t) => {
    const f = await setup(t);
    assert.equal(f.tasks.tasks.size, 0);
    assert.equal(f.raw().sha256, null);
    const start = f.tasks.start({ mode: 'fingerprint', assetIds: f.ids });
    assert.equal(start.status, 'queued');
    assert.equal(start.finishedAt, null);
    const result = await f.tasks.wait(start.id);
    assert.equal(result.status, 'done', JSON.stringify(result.issues));
    assert.equal(result.saved, 1);
    assert.equal(result.dbWritten, 1);
    assert.equal(result.manifestWritten, 1);
    assert.equal(result.bytesRead, result.contentBytesRead + result.metadataBytesRead);
    const row = f.raw();
    assert.equal(row.sha256, crypto.createHash('sha256').update('original bytes').digest('hex'));
    const manifest = (await readManifest(f.roots[0])).manifest;
    const b = manifest.entries[row.id].fingerprintBinding;
    assert.equal(b.version, 1);
    assert.equal(b.sha256, row.sha256);
    assert.equal(b.asset.id, row.id);
    assert.equal(b.root.id, row.root_id);
    assert.ok(b.root.identity);
    assert.equal(b.file.dev, row.dev);
    assert.equal(b.file.ino, row.ino);
    assert.ok(b.file.ctimeMs);
    assert.equal(b.file.size, row.size);
    f.lib.db.close();
    const Database = (await import('better-sqlite3')).default;
    f.lib.db = new Database(path.join(f.base, 'data', 'library.sqlite'));
    assert.equal(f.raw().sha256, b.sha256);
});
test('different inode and different name with same bytes yield read-only content candidate; no automatic identity transfer', async (t) => {
    const f = await setup(t);
    assert.equal((await f.fingerprint()).saved, 1);
    await fs.copyFile(f.files[0], path.join(f.roots[1].path, 'other-name.wav'));
    const targetStat = await fs.stat(path.join(f.roots[1].path, 'other-name.wav'));
    assert.notEqual(targetStat.ino, f.raw().ino);
    await fs.rename(f.files[0], path.join(f.base, 'retained-original.wav'));
    const before = f.raw();
    const result = await f.preview();
    assert.equal(result.status, 'done', JSON.stringify(result.issues));
    assert.equal(result.searchComplete, true);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].contentMatch, true);
    assert.equal(result.candidates[0].physicalIdentityProven, false);
    assert.equal(result.candidates[0].targetRelativePath, 'other-name.wav');
    assert.deepEqual(f.raw(), before);
    assert.equal(f.lib.db.prepare('SELECT COUNT(*) n FROM assets').get().n, 1);
    assert.equal(JSON.stringify(result).includes(f.base), false);
});
test('same size different bytes never match; existing original is copy, not missing source', async (t) => {
    const f = await setup(t);
    await f.fingerprint();
    await fs.writeFile(path.join(f.roots[1].path, 'copy.wav'), 'original bytes');
    let result = await f.preview();
    assert.equal(result.candidates.length, 0);
    assert.equal(result.items[0].state, 'original_present');
    await fs.rename(f.files[0], path.join(f.base, 'retained.wav'));
    await fs.writeFile(path.join(f.roots[1].path, 'copy.wav'), 'different byte');
    result = await f.preview();
    assert.equal(result.candidates.length, 0);
    assert.equal(result.searchComplete, true);
});
test('multiple same-content sources and targets are all ambiguous', async (t) => {
    const f = await setup(t, { count: 2 });
    assert.equal((await f.fingerprint()).saved, 2);
    for (let i = 0; i < 2; i++) {
        await fs.copyFile(f.files[i], path.join(f.roots[1].path, `target-${i}.wav`));
        await fs.rename(f.files[i], path.join(f.base, `retained-${i}.wav`));
    }
    const result = await f.preview();
    assert.equal(result.candidates.length, 4);
    assert.equal(result.candidates.every(c => c.ambiguous), true);
    assert.equal(f.lib.db.prepare('SELECT COUNT(*) n FROM assets').get().n, 2);
});
test('missing pre-move fingerprint or legacy SHA without binding never upgrades to trusted evidence', async (t) => {
    const f = await setup(t);
    await fs.rename(f.files[0], path.join(f.roots[1].path, 'moved.wav'));
    let result = await f.preview();
    assert.equal(result.candidates.length, 0);
    assert.equal(result.issues[0].code, 'NO_TRUSTED_FINGERPRINT');
    f.lib.db.prepare('UPDATE assets SET sha256=? WHERE id=?').run(crypto.createHash('sha256').update('original bytes').digest('hex'), f.ids[0]);
    result = await f.preview();
    assert.equal(result.candidates.length, 0);
    assert.equal(result.issues[0].code, 'NO_TRUSTED_FINGERPRINT');
    assert.equal(result.contentBytesRead, 0);
});
test('quick size/mtime or inode update invalidates both persisted SHA and manifest binding', async (t) => {
    for (const mode of ['current', 'rename', 'replacement']) {
        const f = await setup(t);
        await f.fingerprint();
        assert.equal((await readManifest(f.roots[0])).manifest.entries[f.ids[0]].fingerprintBinding.state, 'committed');
        let target = f.files[0], events = ['source-0.wav'];
        if (mode === 'rename') {
            target = path.join(f.roots[0].path, 'renamed.wav');
            await fs.rename(f.files[0], target);
            events.push('renamed.wav');
        }
        else if (mode === 'replacement') {
            await fs.rename(f.files[0], path.join(f.base, 'retained.wav'));
            await fs.writeFile(target, 'changed bytes!');
        }
        else
            await fs.writeFile(target, 'changed bytes!');
        await reconcilePaths(f.lib, f.roots[0], events, options);
        assert.equal(f.raw().sha256, null);
        const entry = (await readManifest(f.roots[0])).manifest.entries[f.ids[0]];
        assert.equal(entry.sha256, undefined);
        assert.equal(entry.fingerprintBinding, undefined);
    }
});
test('single-sided DB failure leaves pending binding untrusted even when legacy DB hash is equal', async (t) => {
    const f = await setup(t);
    const sha = crypto.createHash('sha256').update('original bytes').digest('hex');
    f.lib.db.prepare('UPDATE assets SET sha256=? WHERE id=?').run(sha, f.ids[0]);
    const prepare = f.lib.db.prepare.bind(f.lib.db);
    f.lib.db.prepare = function (sql) { if (sql.startsWith('UPDATE assets SET sha256=?,dev='))
        throw Object.assign(Error('controlled DB failure'), { code: 'SQLITE_ERROR' }); return prepare(sql); };
    const result = await f.fingerprint();
    assert.equal(result.saved, 0);
    assert.equal(result.status, 'failed');
    assert.equal(result.manifestStaged, 1);
    f.lib.db.prepare = prepare;
    assert.equal((await readManifest(f.roots[0])).manifest.entries[f.ids[0]].fingerprintBinding.state, 'pending');
    await fs.copyFile(f.files[0], path.join(f.roots[1].path, 'same.wav'));
    await fs.rename(f.files[0], path.join(f.base, 'retained.wav'));
    await f.reopen();
    const preview = await f.preview();
    assert.equal(preview.candidates.length, 0);
    assert.equal(preview.issues[0].code, 'NO_TRUSTED_FINGERPRINT');
});
test('backup and final manifest failures never report saved and reopening cannot trust a partial pair', async (t) => {
    for (const phase of ['backup', 'final']) {
        const f = await setup(t), rename = fs.rename;
        let backups = 0;
        fs.rename = async function (from, to, ...args) { if (String(to).endsWith('manifest.json.bak') && ++backups === (phase === 'backup' ? 1 : 2))
            throw Object.assign(Error('controlled backup failure'), { code: 'EIO' }); return rename.call(this, from, to, ...args); };
        let result;
        try {
            result = await f.fingerprint();
        }
        finally {
            fs.rename = rename;
        }
        assert.equal(result.saved, 0);
        assert.equal(result.status, 'failed');
        assert.equal(f.raw().sha256, null);
        assert.equal(result.dbWritten, phase === 'final' ? 1 : 0);
        await fs.copyFile(f.files[0], path.join(f.roots[1].path, 'same.wav'));
        await fs.rename(f.files[0], path.join(f.base, 'retained.wav'));
        await f.reopen();
        assert.equal((await f.preview()).candidates.length, 0);
    }
});
test('source rewrite, root retirement, path change, locks and pending operation at await barrier prevent saving', async (t) => {
    for (const kind of ['file', 'root', 'path', 'lock', 'pending', 'link']) {
        let f;
        f = await setup(t, { taskOptions: { hook: async (point) => { if (point !== 'after-hash')
                    return; if (kind === 'file')
                    await fs.writeFile(f.files[0], 'modified bytes'); if (kind === 'root')
                    f.lib.retireRoot(f.roots[0].id); if (kind === 'path')
                    f.lib.db.prepare('UPDATE assets SET path=? WHERE id=?').run(f.files[0] + '.changed', f.ids[0]); if (kind === 'lock')
                    f.lib.locks.add(f.ids[0]); if (kind === 'pending')
                    f.lib.db.prepare("INSERT INTO operations(id,asset_id,status) VALUES(?,?,'pending')").run(crypto.randomUUID(), f.ids[0]); if (kind === 'link') {
                    await fs.rename(f.files[0], path.join(f.base, 'retained.wav'));
                    await fs.symlink(path.join(f.base, 'retained.wav'), f.files[0]);
                } } } });
        const result = await f.fingerprint();
        assert.equal(result.saved, 0, kind);
        assert.equal(f.raw().sha256, null, kind);
        f.lib.locks.clear();
    }
});
test('byte budget skips oversized file before content open; limits cannot be increased', async (t) => {
    const f = await setup(t, { contents: Buffer.alloc(8192), taskOptions: { limits: { bytes: 4096 } } }), open = fs.open;
    let sourceOpens = 0;
    fs.open = async function (file, ...args) { if (String(file) === f.files[0])
        sourceOpens++; return open.call(this, file, ...args); };
    let result;
    try {
        result = await f.fingerprint();
    }
    finally {
        fs.open = open;
    }
    assert.equal(result.saved, 0);
    assert.equal(sourceOpens, 0);
    assert.equal(result.contentBytesRead, 0);
    assert.ok(result.bytesRead <= 4096);
    assert.equal(result.searchComplete, false);
    assert.equal(result.issues[0].code, 'BYTE_BUDGET');
    for (const limits of [{ files: 51 }, { bytes: 128 * 1024 * 1024 + 1 }, { milliseconds: 10001 }])
        assert.throws(() => new AssetFingerprints(f.lib, { limits }), { code: 'INVALID_LIMIT' });
});
test('51 tiny selected-root files save only hard-cap 50 and never claim complete coverage', async (t) => {
    const f = await setup(t, { count: 51, contents: 'x' });
    const job = f.tasks.start({ mode: 'fingerprint', rootIds: [f.roots[0].id] });
    const result = await f.tasks.wait(job.id);
    assert.equal(result.checked, 50);
    assert.equal(result.saved, 50, JSON.stringify(result.issues));
    assert.equal(result.selectionTruncated, true);
    assert.equal(result.searchComplete, false);
    assert.ok(result.bytesRead <= 128 * 1024 * 1024);
    assert.equal(result.unexaminedAssetIds.length, 1);
    assert.equal(f.lib.db.prepare('SELECT COUNT(*) n FROM assets WHERE sha256 IS NULL').get().n, 1);
    assert.equal((await f.fingerprint(result.unexaminedAssetIds)).saved, 1);
});
test('cancel during actual read waits for real handle close before terminal cancelled', async (t) => {
    const f = await setup(t, { contents: Buffer.alloc(100000) }), open = fs.open;
    let taskId, release, entered, closed = false;
    const ready = new Promise(r => entered = r);
    fs.open = async function (file, ...args) { const h = await open.call(this, file, ...args); if (String(file) === f.files[0]) {
        const read = h.read.bind(h), close = h.close.bind(h);
        h.read = async (...args) => { const value = await read(...args); f.tasks.cancel(taskId); return value; };
        h.close = async () => { entered(); await new Promise(r => release = r); await close(); closed = true; };
    } return h; };
    let result;
    try {
        taskId = f.tasks.start({ mode: 'fingerprint', assetIds: f.ids }).id;
        await ready;
        assert.equal(f.tasks.get(taskId).status, 'cancelling');
        assert.equal(closed, false);
        release();
        result = await f.tasks.wait(taskId);
    }
    finally {
        release?.();
        fs.open = open;
    }
    assert.equal(result.status, 'cancelled');
    assert.equal(result.saved, 0);
    assert.equal(closed, true);
    assert.equal(result.contentBytesRead, 65536);
});
test('10 second asynchronous deadline stops reads, closes handle and leaves no partial hash', async (t) => {
    let clock = 0;
    const f = await setup(t, { contents: Buffer.alloc(100000), taskOptions: { clock: () => clock } }), open = fs.open;
    let closed = false;
    fs.open = async function (file, ...args) { const h = await open.call(this, file, ...args); if (String(file) === f.files[0]) {
        const read = h.read.bind(h), close = h.close.bind(h);
        h.read = async (...args) => { const result = await read(...args); clock = 10000; return result; };
        h.close = async () => { await close(); closed = true; };
    } return h; };
    let result;
    try {
        result = await f.fingerprint();
    }
    finally {
        fs.open = open;
    }
    assert.equal(result.saved, 0);
    assert.equal(result.issues.at(-1).code, 'TIME_BUDGET');
    assert.equal(result.searchComplete, false);
    assert.equal(closed, true);
    assert.equal(f.raw().sha256, null);
});
test('incomplete search and linked target never assert uniqueness', async (t) => {
    const f = await setup(t);
    await f.fingerprint();
    await fs.rename(f.files[0], path.join(f.base, 'retained.wav'));
    await fs.writeFile(path.join(f.roots[1].path, 'first.wav'), 'original bytes');
    await fs.writeFile(path.join(f.roots[1].path, 'second.wav'), 'original bytes');
    f.setTasks({ limits: { files: 1 } });
    let result = await f.preview();
    assert.equal(result.searchComplete, false);
    assert.equal(result.issues.at(-1).code, 'FILE_BUDGET');
    assert.equal(result.candidates.some(c => c.uniqueness !== 'not_asserted'), false);
    await fs.symlink(path.join(f.base, 'retained.wav'), path.join(f.roots[1].path, 'linked.wav'));
    f.setTasks();
    result = await f.preview();
    assert.equal(result.searchComplete, false);
    assert.equal(result.candidates.every(c => c.ambiguous && c.physicalIdentityProven === false), true);
});
test('isolated real index routes enforce session/origin/token, start/query/cancel and disclose no absolute paths', async (t) => {
    const { spawn } = await import('node:child_process'), net = await import('node:net'), { fileURLToPath } = await import('node:url');
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sg-fingerprint-route-')));
    registered.push({ directory: base, policy: 'RETAIN_ALL', setup: true });
    const data = path.join(base, 'data'), media = path.join(base, 'media');
    await fs.mkdir(media);
    const seed = await new Library(data, { directoryClassification: true }).init();
    seed.enqueue = () => { };
    const root = await seed.addRoot(media, 'music');
    await fs.writeFile(path.join(media, 'small.wav'), 'route bytes');
    await reconcileRoot(seed, root, options);
    const assetId = seed.db.prepare('SELECT id FROM assets').get().id;
    seed.db.close();
    const digest = crypto.createHash('sha256').update(await fs.readFile(new URL('../server/trash.swift', import.meta.url))).digest('hex').slice(0, 12);
    await fs.writeFile(path.join(data, 'trash-helper-' + digest), 'fixture marker never executed', { mode: 0o600 });
    const listener = net.createServer();
    await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    const port = listener.address().port;
    await new Promise((resolve, reject) => listener.close(e => e ? reject(e) : resolve()));
    const code = `import {Library} from ${JSON.stringify(new URL('../server/library.mjs', import.meta.url).href)};Library.prototype.enqueue=function(){};await import(${JSON.stringify(new URL('../server/index.mjs', import.meta.url).href)});`;
    const home = path.join(base, 'home'), tmp = path.join(base, 'tmp');
    await fs.mkdir(home);
    await fs.mkdir(tmp);
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmp, LANG: 'en_US.UTF-8', MEDIA_DATA_DIR: data, MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_CLOUD_AUDIO_ENABLED: '', SHIGUANG_AUDIO_ANALYSIS: '', SHIGUANG_CLOUD_RELEASE_CONFIG: path.join(base, 'absent-release.json'), PORT: String(port), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let closed = false, output = '';
    const ended = new Promise(resolve => { child.once('error', e => { output += e.message; closed = true; resolve(); }); child.once('close', (exit, signal) => { closed = true; console.log(JSON.stringify({ routeChildPid: child.pid, exit, signal, knownClosed: true, registeredRoot: base })); resolve(); }); });
    child.stdout.on('data', b => output = (output + b).slice(-65536));
    child.stderr.on('data', b => output = (output + b).slice(-65536));
    t.after(async () => { if (!closed)
        child.kill('SIGTERM'); await ended; });
    let state;
    const deadline = Date.now() + 10000;
    while (!state) {
        assert.equal(closed, false, output);
        assert.ok(Date.now() < deadline, 'private route server readiness');
        try {
            state = JSON.parse(await fs.readFile(path.join(data, 'server.json'), 'utf8'));
            assert.equal(state.pid, child.pid);
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
            await new Promise(r => setTimeout(r, 20));
        }
    }
    const origin = `http://127.0.0.1:${state.port}`, session = await fetch(origin + '/api/session');
    assert.equal(session.status, 200);
    const credentials = await session.json(), cookie = session.headers.get('set-cookie').split(';')[0];
    const post = (body, extra = {}) => fetch(origin + '/api/asset-fingerprints', { method: 'POST', headers: { 'content-type': 'application/json', cookie, origin, 'x-local-token': credentials.token, ...extra }, body: JSON.stringify(body) });
    assert.equal((await fetch(origin + '/api/asset-fingerprints/' + crypto.randomUUID())).status, 401);
    assert.equal((await post({ mode: 'fingerprint', assetIds: [assetId] }, { 'x-local-token': 'invalid' })).status, 403);
    assert.equal((await post({ mode: 'fingerprint', assetIds: [assetId] }, { origin: 'http://example.invalid' })).status, 403);
    assert.equal((await post({ mode: 'fingerprint', assetIds: [assetId], path: media })).status, 400);
    const response = await post({ mode: 'fingerprint', assetIds: [assetId] });
    assert.equal(response.status, 202);
    const queued = await response.json();
    assert.equal(queued.status, 'queued');
    let result = queued;
    while (['queued', 'running', 'cancelling'].includes(result.status)) {
        assert.ok(Date.now() < deadline, 'private job completion');
        result = await (await fetch(origin + '/api/asset-fingerprints/' + queued.id, { headers: { cookie } })).json();
        await new Promise(r => setTimeout(r, 5));
    }
    assert.equal(result.status, 'done', JSON.stringify(result));
    assert.equal(result.saved, 1);
    assert.equal(JSON.stringify(result).includes(base), false);
    const cancel = await fetch(origin + '/api/asset-fingerprints/' + queued.id + '/cancel', { method: 'POST', headers: { cookie, origin, 'x-local-token': credentials.token, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(cancel.status, 200);
    assert.equal((await cancel.json()).status, 'done');
    child.kill('SIGTERM');
    await ended;
    assert.equal(closed, true);
});
test('rewrite during actual chunk reads cannot commit a mixed-content digest', async (t) => {
    const f = await setup(t, { contents: Buffer.alloc(100000) }), open = fs.open;
    let changed = false, closed = false;
    fs.open = async function (file, ...args) { const h = await open.call(this, file, ...args); if (String(file) === f.files[0]) {
        const read = h.read.bind(h), close = h.close.bind(h);
        h.read = async (...args) => { const value = await read(...args); if (!changed) {
            changed = true;
            await fs.writeFile(f.files[0], Buffer.alloc(100000, 2));
        } return value; };
        h.close = async () => { await close(); closed = true; };
    } return h; };
    let result;
    try {
        result = await f.fingerprint();
    }
    finally {
        fs.open = open;
    }
    assert.equal(changed, true);
    assert.equal(closed, true);
    assert.equal(result.saved, 0);
    assert.equal(f.raw().sha256, null);
    assert.equal(result.issues[0].code, 'FILE_CHANGED');
});
test('unavailable source, retired target and source restoration during preview produce no false candidate', async (t) => {
    for (const kind of ['source-offline', 'source-retired', 'target-retired', 'restored']) {
        const f = await setup(t);
        await f.fingerprint();
        const target = path.join(f.roots[1].path, 'candidate.wav');
        await fs.copyFile(f.files[0], target);
        await fs.rename(f.files[0], path.join(f.base, 'retained.wav'));
        if (kind === 'source-offline')
            await fs.rename(f.roots[0].path, f.roots[0].path + '-offline');
        if (kind === 'source-retired')
            f.lib.retireRoot(f.roots[0].id);
        if (kind === 'target-retired')
            f.lib.retireRoot(f.roots[1].id);
        const open = fs.open;
        let restored = false;
        if (kind === 'restored')
            fs.open = async function (file, ...args) { const h = await open.call(this, file, ...args); if (String(file) === target) {
                const read = h.read.bind(h);
                h.read = async (...args) => { const value = await read(...args); if (!restored) {
                    restored = true;
                    await fs.copyFile(target, f.files[0]);
                } return value; };
            } return h; };
        let result;
        try {
            result = await f.preview();
        }
        finally {
            fs.open = open;
        }
        assert.equal(result.candidates.length, 0, kind);
        assert.equal(result.searchComplete, false, kind);
        if (kind === 'restored')
            assert.equal(restored, true);
        assert.equal(f.lib.db.prepare('SELECT COUNT(*) n FROM assets').get().n, 1);
    }
});
test('existing indexed target is identified but never merged or relabelled', async (t) => {
    const f = await setup(t);
    await f.fingerprint();
    const target = path.join(f.roots[1].path, 'indexed.wav');
    await fs.copyFile(f.files[0], target);
    await fs.rename(f.files[0], path.join(f.base, 'retained.wav'));
    await reconcileRoot(f.lib, f.roots[1], options);
    const targetRow = f.lib.db.prepare('SELECT * FROM assets WHERE path=?').get(target);
    f.lib.patch(targetRow.id, { tags: ['target'], note: 'target note', favorite: false });
    const before = f.lib.db.prepare('SELECT * FROM assets WHERE id=?').get(targetRow.id);
    const result = await f.preview();
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].targetAssetId, targetRow.id);
    assert.equal(result.candidates[0].uniqueness, 'not_asserted');
    assert.deepEqual(f.lib.db.prepare('SELECT * FROM assets WHERE id=?').get(targetRow.id), before);
    assert.equal(f.lib.db.prepare('SELECT COUNT(*) n FROM assets').get().n, 2);
});
test('queued cancellation and invalid selections never start implicit work or a second job', async (t) => {
    const f = await setup(t);
    assert.throws(() => f.tasks.start({ mode: 'fingerprint', path: f.base }), { code: 'INVALID_REQUEST' });
    assert.throws(() => f.tasks.start({ mode: 'fingerprint', assetIds: ['../forged'] }), { code: 'INVALID_SELECTION' });
    assert.throws(() => f.tasks.start({ mode: 'fingerprint' }), { code: 'INVALID_SELECTION' });
    const job = f.tasks.start({ mode: 'fingerprint', assetIds: f.ids });
    assert.throws(() => f.tasks.start({ mode: 'fingerprint', assetIds: f.ids }), { code: 'BUSY' });
    assert.equal(f.tasks.cancel(job.id).status, 'cancelling');
    const result = await f.tasks.wait(job.id);
    assert.equal(result.status, 'cancelled');
    assert.equal(result.contentBytesRead, 0);
    assert.equal(result.saved, 0);
    assert.equal(f.raw().sha256, null);
});
test('ctime change invalidates trusted binding even when original size and mtime are restored', async (t) => {
    for (const mode of ['quick', 'full']) {
        const f = await setup(t);
        await fs.utimes(f.files[0], 1000000000.5, 1000000000.5);
        await reconcilePaths(f.lib, f.roots[0], ['source-0.wav'], options);
        assert.equal((await f.fingerprint()).saved, 1);
        const originalMtime = f.raw().mtime;
        await fs.writeFile(f.files[0], 'modified bytes');
        await fs.utimes(f.files[0], 1000000000.5, 1000000000.5);
        assert.equal((await fs.stat(f.files[0])).mtimeMs, originalMtime);
        if (mode === 'quick')
            await reconcilePaths(f.lib, f.roots[0], ['source-0.wav'], options);
        else
            await reconcileRoot(f.lib, f.roots[0], options);
        assert.equal(f.raw().sha256, null);
        assert.equal((await readManifest(f.roots[0])).manifest.entries[f.ids[0]].fingerprintBinding, undefined);
    }
});
test('missing binding fields, pending marker or DB/manifest digest disagreement remain untrusted', async (t) => {
    for (const fault of ['ctime', 'state', 'sha']) {
        const f = await setup(t);
        await f.fingerprint();
        const file = path.join(f.roots[0].path, '.shiguang/manifest.json'), manifest = JSON.parse(await fs.readFile(file, 'utf8'));
        if (fault === 'ctime')
            delete manifest.entries[f.ids[0]].fingerprintBinding.file.ctimeMs;
        if (fault === 'state')
            manifest.entries[f.ids[0]].fingerprintBinding.state = 'pending';
        if (fault === 'sha')
            manifest.entries[f.ids[0]].sha256 = 'a'.repeat(64);
        await fs.writeFile(file, JSON.stringify(manifest));
        await fs.copyFile(f.files[0], path.join(f.roots[1].path, 'same.wav'));
        await fs.rename(f.files[0], path.join(f.base, 'retained.wav'));
        const result = await f.preview();
        assert.equal(result.candidates.length, 0);
        assert.equal(result.issues[0].code, 'NO_TRUSTED_FINGERPRINT');
    }
});

for (const variant of ['retired-source-root', 'source-lock', 'retired-target-root', 'source-revision', 'target-revision', 'source-record', 'source-pending']) {
    test(`final target await rechecks live bindings: ${variant}`, async t => {
        const f = await setup(t);
        assert.equal((await f.fingerprint()).saved, 1);
        const target = path.join(f.roots[1].path, 'final-candidate.wav');
        await fs.copyFile(f.files[0], target);
        await fs.rename(f.files[0], path.join(f.base, 'retained-original.wav'));
        const originalSource = f.tasks.source.bind(f.tasks), originalLstat = fs.lstat;
        let sourceCalls = 0, injected = false;
        f.tasks.source = async (...args) => { const value = await originalSource(...args); sourceCalls++; return value; };
        fs.lstat = async (...args) => {
            const result = await originalLstat(...args);
            if (args[0] === target && sourceCalls >= 2 && !injected) {
                injected = true;
                if (variant === 'retired-source-root') f.lib.db.prepare('UPDATE roots SET retired=1 WHERE id=?').run(f.roots[0].id);
                else if (variant === 'retired-target-root') f.lib.db.prepare('UPDATE roots SET retired=1 WHERE id=?').run(f.roots[1].id);
                else if (variant === 'source-lock') f.lib.locks.add(f.ids[0]);
                else if (variant === 'source-revision') f.lib.db.prepare('UPDATE roots SET revision=revision+1 WHERE id=?').run(f.roots[0].id);
                else if (variant === 'target-revision') f.lib.db.prepare('UPDATE roots SET revision=revision+1 WHERE id=?').run(f.roots[1].id);
                else if (variant === 'source-record') f.lib.db.prepare('UPDATE assets SET name=? WHERE id=?').run('changed-during-await', f.ids[0]);
                else f.lib.db.prepare("INSERT INTO operations (id,asset_id,action,status) VALUES (?,?,'move','pending')").run(crypto.randomUUID(), f.ids[0]);
            }
            return result;
        };
        let result;
        try { result = await f.preview(); }
        finally { fs.lstat = originalLstat; }
        assert.equal(injected, true);
        assert.equal(sourceCalls >= 2, true);
        assert.equal(result.candidates.length, 0);
        assert.equal(result.searchComplete, false);
        assert.equal(result.status, 'done'); // Read-only incomplete preview, not a fake repair failure/success.
        assert.ok(result.issues.some(i => ['ROOT_UNAVAILABLE', 'TARGET_CHANGED', 'BINDING_CHANGED'].includes(i.code)));
    });
}
