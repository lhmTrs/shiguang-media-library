// Manual, account-bound upload intents. Never schedules uploads or imports at startup.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { CLOUD_AUDIO_MESSAGES } from './cloud-audio-service.mjs';
import { rootIdentity } from './fs-identity.mjs';
import { validateCategories, validateFileName } from './cloud-audio-install.mjs';
const MAX = 256000000, BUDGET = 512000000;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const message = {
    SOURCE_CHANGED: '源素材已变化，请核对本次意图，不能沿用旧摘要上传',
    UPLOAD_UNKNOWN: '上传结果未知，请核对原申请；不会自动创建新的共享',
    RECOVERY_UNAVAILABLE: '云端尚未提供可用的提交结果，请保留原申请并手动核对',
    UPLOAD_STATE: '申请当前不能上传，请刷新审批状态',
    UPLOAD_STORAGE: '本地上传记录或快照不可用，请检查后重试',
    UPLOAD_LIMIT: '上传暂存空间或记录已满，请先处理已有意图',
    UPLOAD_ALREADY_COMMITTED: '内容已提交；取消申请不会撤回分享，请使用独立撤回操作',
};
export class CloudUploadError extends Error {
    constructor(code, status = 409) { super(message[code] || CLOUD_AUDIO_MESSAGES[code] || '云端上传操作未完成'); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new CloudUploadError(code, status); };
const identity = auth => { const s = auth.getState(); if (!s.configured || s.state !== 'logged-in' || !s.accountId || !s.deviceId)
    fail('NOT_LOGGED_IN', 401); return { owner: `${s.originHost}|${s.accountId}|${s.deviceId}`, epoch: auth.epoch }; };
const statKey = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
async function hashHandle(f) { const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(65536); let at = 0; const deadline = Date.now() + 120000; for (;;) {
    if (Date.now() > deadline)
        fail('SOURCE_CHANGED');
    const { bytesRead: n } = await f.read(buffer, 0, buffer.length, at);
    if (!n)
        break;
    at += n;
    if (at > MAX)
        fail('SOURCE_CHANGED');
    hash.update(buffer.subarray(0, n));
} return hash.digest('hex'); }
const plain = v => v && typeof v === 'object' && !Array.isArray(v);
const segment = (s, max, empty = false) => typeof s === 'string' && s.length <= max && (empty || s.trim().length > 0) && s === s.trim() && !/[\u0000-\u001f\u007f-\u009f/\\:]/.test(s) && s !== '.' && s !== '..';
export class CloudAudioUpload {
    constructor(lib, { dataDir = lib.dataDir, cloudAuth, enabled = false } = {}) { this.lib = lib; this.dataDir = dataDir; this.auth = cloudAuth; this.enabled = enabled; this.jobs = []; this.controllers = new Map(); this.operations = new Set(); this.busy = false; this.chain = Promise.resolve(); }
    async init() {
        if (!this.enabled)
            return this;
        const base = await fs.realpath(this.dataDir);
        this.dir = path.join(base, 'cloud-upload-intents');
        try {
            await fs.mkdir(this.dir, { mode: 0o700 });
        }
        catch (e) {
            if (e.code !== 'EEXIST')
                throw e;
        }
        const s = await fs.lstat(this.dir);
        if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077))
            fail('UPLOAD_STORAGE', 503);
        this.dirKey = `${s.dev}:${s.ino}`;
        try {
            const f = await fs.open(path.join(this.dir, 'intents.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                if ((await f.stat()).size > 262144)
                    fail('UPLOAD_STORAGE', 503);
                const v = JSON.parse(await f.readFile('utf8'));
                if (!Array.isArray(v) || v.length > 50)
                    fail('UPLOAD_STORAGE', 503);
                for (const j of v) {
                    if (!UUID.test(j.id) || !plain(j) || typeof j.owner !== 'string' || j.owner.length > 300 || !HASH.test(j.sha256 || '') || !Number.isSafeInteger(j.bytes) || j.bytes < 1 || j.bytes > MAX || typeof j.assetId !== 'string')
                        fail('UPLOAD_STORAGE', 503);
                    if (!['prepared', 'requesting', 'ready', 'uploading', 'unknown', 'completed', 'cancelled', 'failed'].includes(j.state) || !['MUSIC', 'SFX'].includes(j.mediaKind) || !segment(j.fileName, 180) || !segment(j.category, 60, true) || !segment(j.subcategory, 60, true) || (j.serverId && !UUID.test(j.serverId)))
                        fail('UPLOAD_STORAGE', 503);
                    try { validateCategories(j.category, j.subcategory); validateFileName(j.fileName); } catch { fail('UPLOAD_STORAGE', 503); }
                    if (j.receipt)
                        j.receipt = this.receipt(j, j.receipt);
                    if (['uploading', 'requesting'].includes(j.state))
                        j.state = 'unknown';
                }
                this.jobs = v;
            }
            finally {
                await f.close();
            }
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw new CloudUploadError('UPLOAD_STORAGE', 503);
        }
        return this;
    }
    guard() { if (!this.enabled)
        fail('CLOUD_AUDIO_DISABLED', 503); return identity(this.auth); }
    async dirGuard() { const s = await fs.lstat(this.dir); if (s.isSymbolicLink() || !s.isDirectory() || `${s.dev}:${s.ino}` !== this.dirKey || (s.mode & 0o077))
        fail('UPLOAD_STORAGE', 503); }
    async save() { const write = async () => { await this.dirGuard(); const tmp = path.join(this.dir, `.intent-${crypto.randomUUID()}`); let f; try {
        f = await fs.open(tmp, 'wx', 0o600);
        const encoded = JSON.stringify(this.jobs);
        if (Buffer.byteLength(encoded) > 262144)
            fail('UPLOAD_LIMIT', 429);
        await f.writeFile(encoded);
        await f.sync();
        await f.close();
        f = null;
        await fs.rename(tmp, path.join(this.dir, 'intents.json'));
        const dir = await fs.open(this.dir, 'r');
        try {
            await dir.sync();
        }
        finally {
            await dir.close();
        }
    }
    finally {
        await f?.close();
        await fs.unlink(tmp).catch(e => { if (e.code !== 'ENOENT')
            throw e; });
    } }; const next = this.chain.then(write); this.chain = next.catch(() => { }); await next.catch(() => fail('UPLOAD_STORAGE', 503)); }
    view(j) { return { id: j.id, assetId: j.assetId, fileName: j.fileName, bytes: j.bytes, sha256: j.sha256, mediaKind: j.mediaKind, visibility: j.visibility, groupId: j.groupId, category: j.category, subcategory: j.subcategory, state: j.state, status: j.status || null, version: j.version ?? null, requestId: j.serverId || null, receipt: j.receipt ? this.receipt(j, j.receipt) : null, error: j.error ? message[j.error] || '操作未完成，请刷新状态后核对' : null }; }
    list() { const who = this.guard(); return this.jobs.filter(j => j.owner === who.owner).map(j => this.view(j)); }
    owned(id) { const who = this.guard(); const j = this.jobs.find(j => j.id === id && j.owner === who.owner); if (!j)
        fail('NOT_FOUND', 404); return { j, who }; }
    check(who) { const now = this.guard(); if (now.owner !== who.owner || now.epoch !== who.epoch)
        fail('AUTH_CHANGED', 409); }
    async source(j) { const a = this.lib.asset(j.assetId); const root = this.lib.rootById(a.root_id); if (root.retired || a.trashed || !['music', 'sfx'].includes(a.kind))
        fail('SOURCE_CHANGED'); const src = await this.lib.source(j.assetId); return { ...src, root, rootKey: await rootIdentity(root) }; }
    async verifySource(j) { const src = await this.source(j); if (src.rootKey !== j.rootKey || statKey(src.stat) !== j.sourceKey)
        fail('SOURCE_CHANGED'); const f = await fs.open(src.p, constants.O_RDONLY | constants.O_NOFOLLOW); try {
        if (statKey(await f.stat()) !== j.sourceKey)
            fail('SOURCE_CHANGED');
        const digest = await hashHandle(f);
        if (digest !== j.sha256 || statKey(await f.stat()) !== j.sourceKey)
            fail('SOURCE_CHANGED');
    }
    finally {
        await f.close();
    } }
    async prepare(input) {
        const who = this.guard();
        if (!plain(input) || Object.keys(input).some(k => !['assetId', 'mediaKind', 'visibility', 'groupId', 'category', 'subcategory'].includes(k)) || !['MUSIC', 'SFX'].includes(input.mediaKind) || !['PRIVATE', 'GROUP'].includes(input.visibility) || !segment(input.category, 60, true) || !segment(input.subcategory, 60, true) || (!input.category && input.subcategory) || (input.visibility === 'GROUP' && !UUID.test(input.groupId || '')) || (input.visibility === 'PRIVATE' && input.groupId))
            fail('INVALID_REQUEST', 400);
        try { validateCategories(input.category, input.subcategory); } catch { fail('INVALID_REQUEST', 400); }
        if (this.jobs.some(j => j.owner === who.owner && j.assetId === input.assetId && !['completed', 'cancelled', 'failed'].includes(j.state)))
            fail('UPLOAD_STATE');
        if (this.busy || this.jobs.length >= 50)
            fail('UPLOAD_LIMIT', 429);
        this.busy = true;
        let file = null, f = null, out = null, j;
        try {
            await this.dirGuard();
            let usage = 0;
            for (const entry of await fs.readdir(this.dir)) {
                const s = await fs.lstat(path.join(this.dir, entry));
                usage += s.isFile() && !s.isSymbolicLink() ? s.size : BUDGET;
            }
            const src = await this.source(input);
            if (src.a.kind !== (input.mediaKind === 'MUSIC' ? 'music' : 'sfx') || src.stat.size < 1 || src.stat.size > MAX || usage + src.stat.size > BUDGET)
                fail('UPLOAD_LIMIT', 413);
            const fileName = path.basename(src.p);
            try { validateFileName(fileName); } catch { fail('INVALID_REQUEST', 400); }
            if (!segment(fileName, 180) || !/^.+\.(wav|mp3|flac|ogg|m4a|aif|aiff|opus)$/i.test(fileName))
                fail('INVALID_REQUEST', 400);
            const id = crypto.randomUUID();
            file = path.join(this.dir, `payload-${id}`);
            f = await fs.open(src.p, constants.O_RDONLY | constants.O_NOFOLLOW);
            if (statKey(await f.stat()) !== statKey(src.stat))
                fail('SOURCE_CHANGED');
            out = await fs.open(file, 'wx', 0o600);
            let bytes = 0;
            const hash = crypto.createHash('sha256');
            const deadline = Date.now() + 120000;
            const buffer = Buffer.alloc(65536);
            let position = 0;
            for (;;) {
                const { bytesRead: n } = await f.read(buffer, 0, buffer.length, position);
                if (!n)
                    break;
                this.check(who);
                bytes += n;
                if (bytes > src.stat.size || Date.now() > deadline)
                    fail('SOURCE_CHANGED');
                hash.update(buffer.subarray(0, n));
                let written = 0;
                while (written < n) {
                    const r = await out.write(buffer, written, n - written, position + written);
                    if (r.bytesWritten < 1)
                        fail('UPLOAD_STORAGE');
                    written += r.bytesWritten;
                }
                position += n;
            }
            await out.sync();
            const current = await this.source(input);
            if (bytes !== src.stat.size || statKey(await f.stat()) !== statKey(src.stat) || current.rootKey !== src.rootKey || statKey(current.stat) !== statKey(src.stat))
                fail('SOURCE_CHANGED');
            this.check(who);
            j = { id, createdAt: Date.now(), owner: who.owner, assetId: input.assetId, mediaKind: input.mediaKind, visibility: input.visibility, groupId: input.groupId || null, category: input.category, subcategory: input.subcategory, fileName, bytes, sha256: hash.digest('hex'), rootKey: src.rootKey, sourceKey: statKey(src.stat), state: 'prepared', serverId: null, status: null, version: null, receipt: null, error: null };
            this.jobs.push(j);
            await this.save();
            file = null;
            this.check(who);
            return this.view(j);
        }
        finally {
            await f?.close();
            await out?.close();
            if (file)
                await fs.unlink(file).catch(() => { });
            this.busy = false;
        }
    }
    async proxy(j, who, method, url, body = null) { this.check(who); let result; try {
        result = await this.auth.proxy(method, url, { body, epoch: who.epoch });
    }
    catch (e) {
        if (e?.status === 401)
            await this.auth.forgetSession?.(e.toPublic?.(), { epoch: who.epoch });
        throw e;
    } this.check(who); return result; }
    applyRequest(j, row) { if (!plain(row) || !UUID.test(row.id || '') || row.requestId !== j.id || row.declaredSha256 !== j.sha256 || row.declaredBytes !== j.bytes || !['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(row.status) || !Number.isSafeInteger(row.version))
        fail('UPLOAD_UNKNOWN'); j.serverId = row.id; j.status = row.status; j.version = row.version; }
    async _request(id) { const { j, who } = this.owned(id); if (!['prepared', 'unknown'].includes(j.state) || j.serverId)
        fail('UPLOAD_STATE'); j.state = 'requesting'; await this.save(); try {
        const r = await this.proxy(j, who, 'POST', '/media/upload-requests', { requestId: j.id, mediaKind: j.mediaKind, fileName: j.fileName, bytes: j.bytes, sha256: j.sha256, visibility: j.visibility, groupId: j.groupId, category: j.category, subcategory: j.subcategory });
        this.applyRequest(j, r);
        j.state = 'ready';
        j.error = null;
    }
    catch {
        j.state = 'unknown';
        j.error = 'UPLOAD_UNKNOWN';
    } await this.save(); return this.view(j); }
    async _refresh(id) { const { j, who } = this.owned(id); if (this.controllers.has(id))
        fail('BUSY', 429); if (!j.serverId)
        return this._request(id); const r = await this.proxy(j, who, 'GET', `/media/upload-requests/${j.serverId}`); this.applyRequest(j, r); if (j.state !== 'unknown' && j.state !== 'completed')
        j.state = r.status === 'CANCELLED' ? 'cancelled' : 'ready'; await this.save(); return this.view(j); }
    receipt(j, r) { if (!plain(r) || !UUID.test(r.audioId || '') || !UUID.test(r.shareId || '') || r.sha256 !== j.sha256 || r.bytes !== j.bytes)
        fail('UPLOAD_UNKNOWN'); return { audioId: r.audioId, shareId: r.shareId, sha256: r.sha256, bytes: r.bytes }; }
    async _reconcile(id) { const { j, who } = this.owned(id); if (!j.serverId || this.controllers.has(id))
        fail('UPLOAD_STATE'); try {
        const r = await this.proxy(j, who, 'GET', `/media/upload-requests/${j.serverId}?includeTransfer=true`);
        if (!plain(r.transfer) || !['COMMITTED', 'NOT_COMMITTED'].includes(r.transfer.commitState))
            fail('RECOVERY_UNAVAILABLE');
        this.applyRequest(j, r.request);
        if (r.transfer.commitState === 'COMMITTED') {
            j.receipt = this.receipt(j, r.transfer.receipt);
            j.state = 'completed';
        }
        else {
            j.state = j.status === 'CANCELLED' ? 'cancelled' : 'ready';
        }
        j.error = null;
        await this.save();
        if (['completed', 'cancelled'].includes(j.state))
            await this.removeSnapshot(j);
        return this.view(j);
    }
    catch {
        j.state = 'unknown';
        j.error = 'RECOVERY_UNAVAILABLE';
        await this.save();
        return this.view(j);
    } }
    async _upload(id) {
        const { j, who } = this.owned(id);
        if (j.state !== 'ready' || j.status !== 'APPROVED' || this.busy || this.controllers.size)
            fail('UPLOAD_STATE');
        this.busy = true;
        const controller = new AbortController();
        this.controllers.set(id, controller);
        const deadlineTimer = setTimeout(() => controller.abort(), 300000);
        let f;
        try {
            if (!Number.isSafeInteger(j.createdAt) || Date.now() - j.createdAt > 86400000)
                fail('SOURCE_CHANGED');
            await this.verifySource(j);
            this.check(who);
            await this.dirGuard();
            f = await fs.open(path.join(this.dir, `payload-${j.id}`), constants.O_RDONLY | constants.O_NOFOLLOW);
            if ((await f.stat()).size !== j.bytes)
                fail('SOURCE_CHANGED');
            const digest = await hashHandle(f);
            if (digest !== j.sha256)
                fail('SOURCE_CHANGED');
            j.state = 'uploading';
            j.error = null;
            await this.save();
            let sent = 0;
            const validate = new Transform({ transform: (chunk, encoding, cb) => { sent += chunk.length; try {
                    this.check(who);
                }
                catch (e) {
                    cb(e);
                    return;
                } if (sent === j.bytes)
                    this.verifySource(j).then(() => cb(null, chunk), cb);
                else
                    cb(null, chunk); } });
            const source = f.createReadStream({ autoClose: true, start: 0 });
            source.on('error', e => validate.destroy(e));
            source.pipe(validate);
            try {
                const r = await this.auth.uploadAudioContent(j.serverId, { source: validate, bytes: j.bytes, epoch: who.epoch, signal: controller.signal });
                this.check(who);
                j.receipt = this.receipt(j, r);
                j.state = 'completed';
                await this.save();
                await this.removeSnapshot(j);
            }
            finally {
                source.destroy();
                validate.destroy();
            }
        }
        catch (e) {
            if (e?.status === 401)
                await this.auth.forgetSession?.(e.toPublic?.(), { epoch: who.epoch });
            j.state = j.state === 'uploading' ? 'unknown' : 'failed';
            j.error = e?.code === 'SOURCE_CHANGED' ? 'SOURCE_CHANGED' : 'UPLOAD_UNKNOWN';
            await this.save();
        }
        finally {
            clearTimeout(deadlineTimer);
            await f?.close();
            this.controllers.delete(id);
            this.busy = false;
        }
        return this.view(j);
    }
    async _cancel(id) {
        const { j, who } = this.owned(id);
        const control = this.controllers.get(id);
        control?.abort();
        if (control)
            return this.view(j);
        if (j.state === 'unknown' && j.serverId) {
            await this._reconcile(id);
            if (j.state === 'unknown')
                fail('RECOVERY_UNAVAILABLE');
        }
        if (j.receipt || j.state === 'completed')
            fail('UPLOAD_ALREADY_COMMITTED');
        if (!j.serverId) {
            if (j.state === 'unknown')
                fail('UPLOAD_UNKNOWN');
            j.state = 'cancelled';
            await this.save();
            await this.removeSnapshot(j);
            return this.view(j);
        }
        try {
            const r = await this.proxy(j, who, 'POST', `/media/upload-requests/${j.serverId}/cancel`, { expectedVersion: j.version });
            this.applyRequest(j, r);
            j.state = 'cancelled';
            j.error = null;
            await this.save();
            await this.removeSnapshot(j);
        }
        catch (e) {
            if (e?.code === 'UPLOAD_ALREADY_COMMITTED')
                fail('UPLOAD_ALREADY_COMMITTED');
            j.state = 'unknown';
            j.error = 'UPLOAD_UNKNOWN';
            await this.save();
        }
        return this.view(j);
    }
    async _forget(id) { const { j } = this.owned(id); if (!['completed', 'cancelled'].includes(j.state))
        fail('UPLOAD_STATE'); await this.removeSnapshot(j); this.jobs = this.jobs.filter(v => v !== j); await this.save(); return { removed: true }; }
    async action(id, method) {
        if (!['request', 'refresh', 'reconcile', 'upload', 'cancel', 'forget'].includes(method))
            fail('INVALID_REQUEST', 400);
        const { who, j } = this.owned(id);
        if (this.operations.has(id)) {
            if (method === 'cancel' && this.controllers.has(id)) {
                this.controllers.get(id).abort();
                return this.view(j);
            }
            fail('BUSY', 429);
        }
        this.operations.add(id);
        try {
            const result = await this['_' + method](id);
            this.check(who);
            return result;
        }
        finally {
            this.operations.delete(id);
        }
    }
    async dispose() { for (const controller of this.controllers.values())
        controller.abort(); await this.chain; }
    async removeSnapshot(j) { await this.dirGuard(); await fs.unlink(path.join(this.dir, `payload-${j.id}`)).catch(e => { if (e.code !== 'ENOENT')
        throw new CloudUploadError('UPLOAD_STORAGE', 503); }); }
}

// Admission only, not a queue: preserve the existing two-download bound by making
// one manual upload exclusive with active/queued/starting downloads.
export function manualAudioAdmission(readDownloadStatus) {
    let uploading = false, startingDownloads = 0;
    return {
        async download(work) {
            if (uploading) fail('BUSY', 429);
            startingDownloads++;
            try { return await work(); }
            finally { startingDownloads--; }
        },
        async upload(work) {
            if (uploading || startingDownloads) fail('BUSY', 429);
            uploading = true;
            try {
                const status = await readDownloadStatus();
                if (status.active || status.queued) fail('BUSY', 429);
                return await work();
            } finally { uploading = false; }
        },
    };
}
