// User-started bounded jobs. No startup traversal, listeners, network or default instance.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fingerprintRootIdentity as rootIdentity, within, kindForExt, stableFileSha256, fingerprintFileIdentity } from './fs-identity.mjs';
import { emptyManifest, entryFromAsset } from './fs-manifest.mjs';
export const FINGERPRINT_LIMITS = Object.freeze({ files: 50, bytes: 128 * 1024 * 1024, milliseconds: 10000, roots: 16, entries: 1000, manifestBytes: 4 * 1024 * 1024, tasks: 16, candidates: 200 });
const active = new Set(['queued', 'running', 'cancelling']), hash = /^[a-f0-9]{64}$/, uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const copy = v => JSON.parse(JSON.stringify(v)), same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = code => { throw Object.assign(Error(code), { code }); };
const assetBinding = a => ({ id: a.id, rootId: a.root_id, path: a.path, size: a.size, mtime: a.mtime, dev: a.dev, ino: a.ino });
const rootBinding = r => ({ id: r.id, path: r.path, kind: r.kind, revision: Number(r.revision || 0) });
export class AssetFingerprints {
    constructor(lib, { clock = () => performance.now(), limits = {}, hook = async () => { } } = {}) {
        this.lib = lib;
        this.clock = clock;
        this.hook = hook;
        this.tasks = new Map();
        this.limits = { ...FINGERPRINT_LIMITS };
        for (const [k, v] of Object.entries(limits)) {
            if (!['files', 'bytes', 'milliseconds', 'entries'].includes(k) || !Number.isSafeInteger(v) || v < 1 || v > FINGERPRINT_LIMITS[k])
                fail('INVALID_LIMIT');
            this.limits[k] = v;
        }
    }
    get(taskId) { if (!uuid.test(taskId || ''))
        fail('INVALID_TASK'); const state = this.tasks.get(taskId); if (!state)
        fail('TASK_NOT_FOUND'); return copy(state.job); }
    start(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['mode', 'rootIds', 'assetIds'].includes(k)) || !['fingerprint', 'preview'].includes(input.mode))
            fail('INVALID_REQUEST');
        for (const [key, max] of [['rootIds', this.limits.roots], ['assetIds', this.limits.files]]) {
            const value = input[key] ?? [];
            if (!Array.isArray(value) || value.length > max || new Set(value).size !== value.length || value.some(v => !uuid.test(v)))
                fail('INVALID_SELECTION');
        }
        const selected = { mode: input.mode, rootIds: [...(input.rootIds || [])], assetIds: [...(input.assetIds || [])] };
        if (!selected.rootIds.length && !selected.assetIds.length || selected.mode === 'preview' && (!selected.rootIds.length || !selected.assetIds.length))
            fail('INVALID_SELECTION');
        if (this.lib.locks.size || [...this.lib.jobs.values()].some(j => active.has(j.status)))
            fail('BUSY');
        if (this.tasks.size >= this.limits.tasks) {
            const old = [...this.tasks].find(([, s]) => !active.has(s.job.status));
            if (!old)
                fail('TASK_LIMIT');
            this.tasks.delete(old[0]);
            this.lib.jobs.delete(old[0]);
        }
        const taskId = crypto.randomUUID(), job = { id: taskId, taskId, type: 'asset-fingerprint', mode: selected.mode, label: selected.mode === 'preview' ? '内容一致候选预览' : '建立内容指纹', status: 'queued', checked: 0, saved: 0, dbWritten: 0, manifestWritten: 0, manifestStaged: 0, metadataBytesRead: 0, skipped: 0, bytesRead: 0, contentBytesRead: 0, entriesVisited: 0, selectionCount: null, remainingSelected: null, selectionTruncated: false, unexaminedAssetIds: [], unexaminedRootIds: [], searchComplete: false, resultTruncated: false, issues: [], items: [], candidates: [], startedAt: null, finishedAt: null };
        const state = { job, selected, controller: new AbortController(), start: null, failedPersistence: false };
        this.tasks.set(taskId, state);
        this.lib.jobs.set(taskId, job);
        state.promise = new Promise(resolve => setImmediate(resolve)).then(() => this.work(state));
        return this.get(taskId);
    }
    cancel(taskId) { const state = this.tasks.get(taskId); if (!state)
        fail('TASK_NOT_FOUND'); if (active.has(state.job.status)) {
        state.job.status = 'cancelling';
        state.controller.abort();
    } return this.get(taskId); }
    async wait(taskId) { const state = this.tasks.get(taskId); if (!state)
        fail('TASK_NOT_FOUND'); await state.promise; return this.get(taskId); }
    async dispose() { for (const [id, s] of this.tasks)
        if (active.has(s.job.status))
            this.cancel(id); await Promise.all([...this.tasks.values()].map(s => s.promise)); }
    check(s) { if (s.controller.signal.aborted)
        fail(s.controller.signal.reason === 'TIME_BUDGET' ? 'TIME_BUDGET' : 'CANCELLED'); if (this.clock() - s.start >= this.limits.milliseconds)
        fail('TIME_BUDGET'); }
    issue(s, assetId, code) { s.job.skipped++; if (s.job.issues.length < 100)
        s.job.issues.push({ assetId, code: /^[A-Z_]+$/.test(code || '') ? code : 'UNAVAILABLE' }); }
    root(id) { const r = this.lib.db.prepare('SELECT * FROM roots WHERE id=?').get(id); if (!r || r.retired)
        fail('ROOT_UNAVAILABLE'); if (!Number.isSafeInteger(Number(r.revision || 0)) || Number(r.revision || 0) < 0)
        fail('ROOT_VERSION_UNAVAILABLE'); return r; }
    sameRoot(snapshot) { return same(rootBinding(this.root(snapshot.id)), rootBinding(snapshot)); }
    asset(id) { const a = this.lib.db.prepare('SELECT * FROM assets WHERE id=?').get(id); if (!a || a.trashed)
        fail('ASSET_UNAVAILABLE'); return a; }
    guardAsset(s, a, r) { this.check(s); if (!this.sameRoot(r) || !same(this.asset(a.id), a) || this.lib.locks.has(a.id) || this.lib.db.prepare("SELECT id FROM operations WHERE asset_id=? AND status='pending'").get(a.id))
        fail('BINDING_CHANGED'); }
    async metadata(s, r) {
        this.check(s);
        const rootKey = await rootIdentity(r);
        this.check(s);
        const dir = path.join(r.path, '.shiguang'), file = path.join(dir, 'manifest.json');
        let handle;
        try {
            try {
                const d = await fs.lstat(dir);
                if (!d.isDirectory() || d.isSymbolicLink() || await fs.realpath(dir) !== dir)
                    fail('MANIFEST_UNSAFE');
            }
            catch (e) {
                if (e.code === 'ENOENT')
                    return { manifest: emptyManifest(r), raw: null, fileIdentity: null, rootKey, dirKey: null };
                throw e;
            }
            const dirStat = await fs.lstat(dir), dirKey = `${dirStat.dev}:${dirStat.ino}`;
            try {
                handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            }
            catch (e) {
                if (e.code === 'ENOENT')
                    return { manifest: emptyManifest(r), raw: null, fileIdentity: null, rootKey, dirKey };
                throw e;
            }
            const stat = await handle.stat();
            if (!stat.isFile() || stat.nlink !== 1 || stat.size > this.limits.manifestBytes)
                fail('MANIFEST_LIMIT');
            if (stat.size > this.limits.bytes - s.job.bytesRead)
                fail('BYTE_BUDGET');
            const buffer = Buffer.alloc(Math.min(65536, Math.max(1, stat.size))), parts = [];
            let position = 0;
            while (position < stat.size) {
                this.check(s);
                const { bytesRead: n } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
                s.job.bytesRead += n;
                s.job.metadataBytesRead += n;
                this.check(s);
                if (n < 1)
                    fail('MANIFEST_CHANGED');
                parts.push(Buffer.from(buffer.subarray(0, n)));
                position += n;
            }
            if (!same(fingerprintFileIdentity(await handle.stat()), fingerprintFileIdentity(stat)) || !same(fingerprintFileIdentity(await fs.lstat(file)), fingerprintFileIdentity(stat)))
                fail('MANIFEST_CHANGED');
            const raw = Buffer.concat(parts).toString('utf8');
            let manifest;
            try {
                manifest = JSON.parse(raw);
            }
            catch {
                fail('MANIFEST_INVALID');
            }
            if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !manifest.entries || typeof manifest.entries !== 'object' || Array.isArray(manifest.entries) || Object.keys(manifest.entries).length > 20000)
                fail('MANIFEST_INVALID');
            this.check(s);
            return { manifest, raw, fileIdentity: fingerprintFileIdentity(stat), rootKey, dirKey };
        }
        finally {
            await handle?.close();
        }
    }
    async hashFile(s, r, file) { this.check(s); if (s.job.checked >= this.limits.files)
        fail('FILE_BUDGET'); s.job.checked++; return stableFileSha256(r, file, { remainingBytes: this.limits.bytes - s.job.bytesRead, signal: s.controller.signal, check: () => this.check(s), onRead: n => { s.job.bytesRead += n; s.job.contentBytesRead += n; }, }); }
    async manifestGuard(s, r, meta, guard) { this.check(s); guard(); if (await rootIdentity(r) !== meta.rootKey)
        fail('ROOT_CHANGED'); this.check(s); guard(); const dir = path.join(r.path, '.shiguang'); const st = await fs.lstat(dir); if (!st.isDirectory() || st.isSymbolicLink() || await fs.realpath(dir) !== dir || meta.dirKey && `${st.dev}:${st.ino}` !== meta.dirKey)
        fail('MANIFEST_UNSAFE'); let current; try {
        current = fingerprintFileIdentity(await fs.lstat(path.join(dir, 'manifest.json')));
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
        current = null;
    } this.check(s); guard(); if (!same(current, meta.fileIdentity))
        fail('MANIFEST_CHANGED'); return dir; }
    async persistManifest(s, r, meta, value, guard) {
        if (process.env.MEDIA_READONLY_FILES === '1')
            fail('MANIFEST_READONLY');
        const encoded = Buffer.from(JSON.stringify(value, null, 2) + '\n');
        if (encoded.length > this.limits.manifestBytes)
            fail('MANIFEST_LIMIT');
        this.check(s);
        guard();
        if (await rootIdentity(r) !== meta.rootKey)
            fail('ROOT_CHANGED');
        const dir = path.join(r.path, '.shiguang');
        await fs.mkdir(dir, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST')
            throw e; });
        if (!meta.dirKey) {
            const stat = await fs.lstat(dir);
            if (!stat.isDirectory() || stat.isSymbolicLink())
                fail('MANIFEST_UNSAFE');
            meta.dirKey = `${stat.dev}:${stat.ino}`;
        }
        // mkdir EEXIST handled below via the same pinned directory checks.
        return this.writeManifestFiles(s, r, meta, encoded, guard);
    }
    async writeManifestFiles(s, r, meta, encoded, guard) {
        const dir = await this.manifestGuard(s, r, meta, guard), temps = [];
        const temp = async (bytes) => { const file = path.join(dir, `fingerprint-${crypto.randomUUID()}.tmp`), handle = await fs.open(file, 'wx', 0o600); let identity; try {
            identity = fingerprintFileIdentity(await handle.stat());
            temps.push({ file, identity });
            await handle.writeFile(bytes);
            this.check(s);
            guard();
            await handle.sync();
        }
        finally {
            await handle.close();
        } return file; };
        try {
            const next = await temp(encoded), backup = meta.raw === null ? null : await temp(Buffer.from(meta.raw));
            await this.manifestGuard(s, r, meta, guard);
            if (backup) {
                await fs.rename(backup, path.join(dir, 'manifest.json.bak'));
                this.check(s);
                guard();
            }
            await this.manifestGuard(s, r, meta, guard);
            await fs.rename(next, path.join(dir, 'manifest.json'));
            const handle = await fs.open(dir, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            this.check(s);
            guard();
        }
        finally {
            for (const t of temps)
                try {
                    const d = await fs.lstat(dir), current = await fs.lstat(t.file);
                    if (d.isDirectory() && !d.isSymbolicLink() && current.isFile() && !current.isSymbolicLink() && current.nlink === 1 && current.dev === t.identity.dev && current.ino === t.identity.ino && await rootIdentity(r) === meta.rootKey)
                        await fs.unlink(t.file);
                }
                catch { /* retain unknown private temporary files */ }
        }
    }
    async fingerprint(s, a) {
        const r = this.root(a.root_id);
        if (!within(r.path, a.path) || !kindForExt(a.ext, r.kind))
            fail('INVALID_FILE');
        this.guardAsset(s, a, r);
        const meta = await this.metadata(s, r);
        this.guardAsset(s, a, r);
        const result = await this.hashFile(s, r, a.path);
        await this.hook('after-hash', { assetId: a.id });
        this.guardAsset(s, a, r);
        if (a.dev != null && result.file.dev !== Number(a.dev) || a.ino != null && result.file.ino !== Number(a.ino) || result.file.size !== Number(a.size) || result.file.mtimeMs !== Number(a.mtime) || result.rootIdentity !== meta.rootKey)
            fail('BINDING_CHANGED');
        const binding = { version: 1, state: 'pending', sha256: result.sha256, asset: assetBinding({ ...a, dev: result.file.dev, ino: result.file.ino }), root: { ...rootBinding(r), identity: result.rootIdentity }, file: result.file, checkedAt: new Date().toISOString() };
        meta.manifest.entries[a.id] = { ...meta.manifest.entries[a.id], ...entryFromAsset({ ...a, sha256: result.sha256, rel_path: path.relative(r.path, a.path).split(path.sep).join('/') }), fingerprintBinding: binding };
        meta.manifest.revision = Number(meta.manifest.revision || 0) + 1;
        const guard = () => this.guardAsset(s, a, r);
        try {
            await this.persistManifest(s, r, meta, meta.manifest, guard);
            s.job.manifestStaged++;
        }
        catch (e) {
            if (['CANCELLED', 'TIME_BUDGET'].includes(e.code))
                throw e;
            fail('MANIFEST_WRITE_FAILED');
        }
        await this.hook('after-manifest', { assetId: a.id });
        this.guardAsset(s, a, r);
        const stat = await fs.lstat(a.path);
        this.check(s);
        if (!same(fingerprintFileIdentity(stat), result.file) || await rootIdentity(r) !== result.rootIdentity)
            fail('FILE_CHANGED');
        let committedAsset, committedRoot;
        try {
            this.lib.db.transaction(() => { this.guardAsset(s, a, r); this.lib.db.prepare('UPDATE assets SET sha256=?,dev=?,ino=? WHERE id=?').run(result.sha256, result.file.dev, result.file.ino, a.id); this.lib.db.prepare('UPDATE roots SET revision=COALESCE(revision,0)+1 WHERE id=?').run(r.id); committedAsset = this.asset(a.id); committedRoot = this.root(r.id); })();
            s.job.dbWritten++;
        }
        catch (e) {
            if (['BINDING_CHANGED', 'ROOT_UNAVAILABLE', 'CANCELLED', 'TIME_BUDGET'].includes(e.code))
                throw e;
            fail('DB_WRITE_FAILED');
        }
        try {
            const staged = await this.metadata(s, committedRoot);
            if (!same(staged.manifest.entries[a.id]?.fingerprintBinding, binding))
                fail('MANIFEST_CHANGED');
            const finalGuard = () => this.guardAsset(s, committedAsset, committedRoot);
            finalGuard();
            if (!same(fingerprintFileIdentity(await fs.lstat(a.path)), result.file) || await rootIdentity(committedRoot) !== result.rootIdentity)
                fail('FILE_CHANGED');
            staged.manifest.entries[a.id].fingerprintBinding = { ...binding, state: 'committed' };
            staged.manifest.revision = Number(staged.manifest.revision || 0) + 1;
            await this.persistManifest(s, committedRoot, staged, staged.manifest, finalGuard);
            if (!same(fingerprintFileIdentity(await fs.lstat(a.path)), result.file) || await rootIdentity(committedRoot) !== result.rootIdentity)
                fail('FILE_CHANGED');
            finalGuard();
            s.job.manifestWritten++;
            s.job.saved++;
            s.job.items.push({ assetId: a.id, state: 'saved', sha256: result.sha256 });
        }
        catch (e) {
            // A one-sided save must not turn a legacy/equal hash into a committed binding.
            try {
                this.lib.db.transaction(() => { if (same(this.asset(a.id), committedAsset))
                    this.lib.db.prepare('UPDATE assets SET sha256=NULL WHERE id=?').run(a.id); })();
            }
            catch { /* unknown DB failure remains reported, never counted saved */ }
            if (['CANCELLED', 'TIME_BUDGET'].includes(e.code))
                throw e;
            fail('MANIFEST_COMMIT_FAILED');
        }
    }
    async missing(s, r, file) {
        if (!within(r.path, file) || file === r.path)
            fail('INVALID_FILE');
        try {
            await fs.lstat(file);
            return false;
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
        }
        let parent = path.dirname(file);
        for (let depth = 0; depth < 128 && within(r.path, parent); depth++) {
            this.check(s);
            try {
                const stat = await fs.lstat(parent);
                if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(parent) !== parent)
                    fail('FILE_LINK');
                this.check(s);
                return true;
            }
            catch (e) {
                if (e.code !== 'ENOENT')
                    throw e;
            }
            if (parent === r.path)
                break;
            parent = path.dirname(parent);
        }
        fail('PATH_UNAVAILABLE');
    }
    async source(s, id) {
        const a = this.asset(id), r = this.root(a.root_id), meta = await this.metadata(s, r);
        this.guardAsset(s, a, r);
        const entry = meta.manifest.entries[a.id], b = entry?.fingerprintBinding;
        if (!hash.test(a.sha256 || '') || !b || b.version !== 1 || b.state !== 'committed' || b.sha256 !== a.sha256 || entry.sha256 !== a.sha256 || !same(b.asset, assetBinding(a)) || b.root?.id !== r.id || b.root.path !== r.path || b.root.kind !== r.kind || b.root.identity !== meta.rootKey || !b.file || b.file.nlink !== 1 || ![b.file.ctimeMs, b.file.mtimeMs, b.file.birthtimeMs].every(n => Number.isFinite(n) && n >= 0) || ![b.file.dev, b.file.ino, b.file.size].every(Number.isSafeInteger) || !Number.isFinite(Date.parse(b.checkedAt)) || b.file.dev !== Number(a.dev) || b.file.ino !== Number(a.ino) || b.file.size !== Number(a.size) || b.file.mtimeMs !== Number(a.mtime))
            return { assetId: id, state: 'no_trusted_fingerprint', code: 'NO_TRUSTED_FINGERPRINT' };
        if (!await this.missing(s, r, a.path))
            return { assetId: id, state: 'original_present', code: 'ORIGINAL_PRESENT' };
        this.check(s);
        return { assetId: id, state: 'missing', sha256: a.sha256, a, r, rootIdentity: meta.rootKey, binding: b };
    }
    async *files(s, r) {
        const stack = [r.path];
        while (stack.length) {
            this.check(s);
            const directory = stack.pop();
            if (await fs.realpath(directory) !== directory || !within(r.path, directory))
                fail('ROOT_CHANGED');
            const handle = await fs.opendir(directory);
            try {
                for await (const entry of handle) {
                    this.check(s);
                    if (++s.job.entriesVisited > this.limits.entries)
                        fail('ENTRY_BUDGET');
                    if (entry.name.startsWith('.'))
                        continue;
                    const file = path.join(directory, entry.name);
                    if (entry.isSymbolicLink()) {
                        s.incomplete = true;
                        this.issue(s, null, 'FILE_LINK');
                        continue;
                    }
                    if (entry.isDirectory()) {
                        if (stack.length >= 128)
                            fail('ENTRY_BUDGET');
                        stack.push(file);
                    }
                    else if (entry.isFile() && kindForExt(path.extname(entry.name).slice(1), r.kind))
                        yield file;
                }
            }
            finally {
                await handle.close().catch(e => { if (e.code !== 'ERR_DIR_CLOSED')
                    throw e; });
            }
        }
    }
    async preview(s) {
        const sources = [];
        for (const id of s.selected.assetIds) {
            this.check(s);
            try {
                const source = await this.source(s, id);
                if (source.state === 'missing')
                    sources.push(source);
                else {
                    this.issue(s, id, source.code);
                    s.job.items.push(source);
                }
            }
            catch (e) {
                this.issue(s, id, e.code);
                s.job.items.push({ assetId: id, state: 'unavailable' });
                s.incomplete = true;
            }
        }
        if (!sources.length) {
            s.job.selectionCount = s.selected.assetIds.length;
            s.job.remainingSelected = 0;
            return;
        }
        const found = [];
        for (const id of s.selected.rootIds) {
            let r;
            try {
                r = this.root(id);
                const key = await rootIdentity(r);
                for await (const file of this.files(s, r)) {
                    try {
                        const result = await this.hashFile(s, r, file);
                        if (!this.sameRoot(r) || await rootIdentity(r) !== key)
                            fail('ROOT_CHANGED');
                        if (sources.some(a => a.sha256 === result.sha256))
                            found.push({ rootId: id, relativePath: path.relative(r.path, file).split(path.sep).join('/'), sha256: result.sha256, file: result.file, root: r, identity: key });
                    }
                    catch (e) {
                        if (['CANCELLED', 'TIME_BUDGET', 'FILE_BUDGET'].includes(e.code))
                            throw e;
                        s.incomplete = true;
                        this.issue(s, null, e.code);
                    }
                }
            }
            catch (e) {
                if (['CANCELLED', 'TIME_BUDGET', 'FILE_BUDGET', 'ENTRY_BUDGET'].includes(e.code))
                    throw e;
                s.incomplete = true;
                this.issue(s, null, e.code);
            }
        }
        const current = [];
        for (const old of sources) {
            try {
                const fresh = await this.source(s, old.assetId);
                if (fresh.state !== 'missing' || !same(fresh.binding, old.binding)) {
                    this.issue(s, old.assetId, 'SOURCE_CHANGED');
                    s.incomplete = true;
                }
                else
                    current.push(fresh);
            }
            catch (e) {
                s.incomplete = true;
                this.issue(s, old.assetId, e.code);
            }
        }
        for (const candidate of found) {
            try {
                this.check(s);
                if (!this.sameRoot(candidate.root) || await rootIdentity(candidate.root) !== candidate.identity || !same(fingerprintFileIdentity(await fs.lstat(path.join(candidate.root.path, candidate.relativePath))), candidate.file))
                    fail('TARGET_CHANGED');
                // The awaited physical checks allow normal in-process registration/lock
                // changes. Recheck live state synchronously before publishing any match.
                this.check(s);
                if (!this.sameRoot(candidate.root))
                    fail('TARGET_CHANGED');
                const matches = current.filter(a => a.sha256 === candidate.sha256);
                for (const source of matches) {
                    try {
                        this.guardAsset(s, source.a, source.r);
                    }
                    catch (e) {
                        s.incomplete = true;
                        this.issue(s, source.assetId, e.code);
                        continue;
                    }
                    const sourceCount = this.lib.db.prepare('SELECT COUNT(*) n FROM assets WHERE sha256=? AND trashed=0').get(candidate.sha256).n;
                    const targets = found.filter(f => f.sha256 === candidate.sha256).length;
                    if (s.job.candidates.length >= this.limits.candidates) {
                        s.incomplete = true;
                        s.job.resultTruncated = true;
                        break;
                    }
                    s.job.candidates.push({ sourceAssetId: source.assetId, targetAssetId: this.lib.db.prepare('SELECT id FROM assets WHERE path=? AND trashed=0').get(path.join(candidate.root.path, candidate.relativePath))?.id ?? null, uniqueness: 'not_asserted', targetRootId: candidate.rootId, targetRelativePath: candidate.relativePath, sha256: candidate.sha256, contentMatch: true, ambiguous: sourceCount > 1 || matches.length > 1 || targets > 1, physicalIdentityProven: false });
                }
            }
            catch (e) {
                s.incomplete = true;
                this.issue(s, null, e.code);
            }
        }
        s.job.searchComplete = !s.incomplete;
        s.job.selectionCount = s.selected.assetIds.length;
        s.job.remainingSelected = 0;
    }
    async work(s) {
        s.start = this.clock();
        s.job.startedAt = Date.now();
        const deadlineTimer = setTimeout(() => { if (!s.controller.signal.aborted) { s.job.status = 'cancelling'; s.controller.abort('TIME_BUDGET'); } }, this.limits.milliseconds);
        try {
            this.check(s);
            if (this.lib.locks.size || [...this.lib.jobs.values()].some(j => j.id !== s.job.id && active.has(j.status)))
                fail('BUSY');
            s.job.status = 'running';
            if (s.selected.mode === 'preview')
                await this.preview(s);
            else {
                let assets = [];
                const visitedRoots = new Set();
                if (s.selected.assetIds.length)
                    assets = s.selected.assetIds.map(id => this.asset(id));
                else
                    for (const id of s.selected.rootIds) {
                        const r = this.root(id);
                        visitedRoots.add(id);
                        assets.push(...this.lib.db.prepare('SELECT * FROM assets WHERE root_id=? AND trashed=0 ORDER BY id LIMIT ?').all(r.id, this.limits.files + 1));
                        if (assets.length > this.limits.files)
                            break;
                    }
                if (s.selected.rootIds.length && assets.some(a => !s.selected.rootIds.includes(a.root_id)))
                    fail('INVALID_SELECTION');
                s.job.unexaminedAssetIds = assets.slice(this.limits.files).map(a => a.id);
                s.job.unexaminedRootIds = s.selected.assetIds.length ? [] : s.selected.rootIds.filter(id => !visitedRoots.has(id));
                s.job.selectionTruncated = assets.length > this.limits.files || s.job.unexaminedRootIds.length > 0;
                assets = assets.slice(0, this.limits.files);
                s.job.selectionCount = assets.length;
                s.job.remainingSelected = assets.length;
                for (const a of assets) {
                    this.check(s);
                    try {
                        await this.fingerprint(s, a);
                    }
                    catch (e) {
                        if (['CANCELLED', 'TIME_BUDGET', 'FILE_BUDGET'].includes(e.code))
                            throw e;
                        if (/^MANIFEST_|^SQLITE_|^DB_/.test(e.code || ''))
                            s.failedPersistence = true;
                        this.issue(s, a.id, e.code);
                        s.job.items.push({ assetId: a.id, state: 'skipped', code: e.code || 'UNAVAILABLE' });
                    }
                    s.job.remainingSelected--;
                }
                s.job.searchComplete = !s.job.selectionTruncated && !s.job.skipped;
            }
            this.check(s);
            s.job.status = s.failedPersistence ? 'failed' : 'done';
        }
        catch (e) {
            if (e.code === 'CANCELLED')
                s.job.status = 'cancelled';
            else if (['TIME_BUDGET', 'FILE_BUDGET', 'ENTRY_BUDGET', 'BYTE_BUDGET'].includes(e.code)) {
                s.job.status = 'done';
                s.incomplete = true;
                s.job.issues.push({ assetId: null, code: e.code });
            }
            else {
                s.job.status = 'failed';
                s.job.issues.push({ assetId: null, code: e.code || 'UNAVAILABLE' });
            }
            s.job.searchComplete = false;
        }
        finally {
            clearTimeout(deadlineTimer);
            s.job.finishedAt = Date.now();
        }
    }
}
