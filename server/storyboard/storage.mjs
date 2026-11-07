import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateProject, pretty } from './shared/model.mjs';
export const digest = data => createHash('sha256').update(data).digest('hex');
export class StoreError extends Error {
    constructor(message, status = 400, details = {}) { super(message); this.status = status; this.details = details; }
}
export class ProjectStore {
    constructor(root) { this.root = path.resolve(root); this.locks = new Map(); }
    validId(id) { if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(id))
        throw new StoreError('项目 ID 只能使用英文字母、数字、下划线与短横线'); return id; }
    async owned(relative, { createParents = false } = {}) { const target = path.resolve(this.root, relative); if (target !== this.root && !target.startsWith(this.root + path.sep))
        throw new StoreError('路径超出项目目录'); await fs.mkdir(this.root, { recursive: true }); const rootStat = await fs.lstat(this.root); if (rootStat.isSymbolicLink())
        throw new StoreError('工作目录不能是符号链接'); const parts = path.relative(this.root, target).split(path.sep).filter(Boolean); let cursor = this.root; for (let i = 0; i < parts.length; i++) {
        cursor = path.join(cursor, parts[i]);
        try {
            const stat = await fs.lstat(cursor);
            if (stat.isSymbolicLink())
                throw new StoreError('项目路径不能含符号链接');
            if (i < parts.length - 1 && !stat.isDirectory())
                throw new StoreError('父路径不是目录');
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
            if (createParents && i < parts.length - 1)
                await fs.mkdir(cursor);
        }
    } return target; }
    async read(id) { this.validId(id); const file = await this.owned(`${id}/project.storyboard.json`); let raw; try {
        raw = await fs.readFile(file, 'utf8');
    }
    catch (e) {
        if (e.code === 'ENOENT')
            throw new StoreError('项目不存在', 404);
        throw e;
    } let project; try {
        project = JSON.parse(raw);
    }
    catch {
        throw new StoreError('磁盘 JSON 无法解析，原文件已保留', 422, { raw });
    } const errors = validateProject(project); if (errors.length)
        throw new StoreError('磁盘项目校验失败，原文件已保留', 422, { errors, raw }); if (project.project_id !== id)
        throw new StoreError('文件夹与项目 ID 不一致', 422); const missing_assets = []; for (const a of project.assets) {
        try {
            await fs.access(await this.owned(`${id}/${a.path}`));
        }
        catch {
            missing_assets.push(a.id);
        }
    } return { project, hash: digest(raw), file, missing_assets }; }
    async list() { await this.owned(''); const dirs = await fs.readdir(this.root, { withFileTypes: true }); const rows = []; for (const d of dirs) {
        if (!d.isDirectory() || !/^[a-zA-Z0-9_-]{1,160}$/.test(d.name))
            continue;
        try {
            const r = await this.read(d.name);
            rows.push({ id: d.name, title: r.project.title, revision: r.project.revision, file: r.file, hash: r.hash });
        }
        catch (e) {
            rows.push({ id: d.name, title: d.name, error: e.message });
        }
    } return rows; }
    async save(project, expectedHash) { const id = this.validId(project?.project_id); const previous = this.locks.get(id) ?? Promise.resolve(); const operation = previous.catch(() => { }).then(() => this._save(project, expectedHash)); this.locks.set(id, operation); try {
        return await operation;
    }
    finally {
        if (this.locks.get(id) === operation)
            this.locks.delete(id);
    } }
    async _save(project, expectedHash) {
        const errors = validateProject(project);
        if (errors.length)
            throw new StoreError('项目校验未通过', 422, { errors });
        const id = project.project_id, file = await this.owned(`${id}/project.storyboard.json`, { createParents: true });
        const getRaw = async () => { try {
            return await fs.readFile(file, 'utf8');
        }
        catch (e) {
            if (e.code === 'ENOENT')
                return null;
            throw e;
        } };
        const prior = await getRaw(), hash = prior === null ? null : digest(prior);
        if (hash !== expectedHash)
            throw new StoreError('磁盘文件已变化；本地编辑未被覆盖', 409, { disk_hash: hash, disk_raw: prior });
        // Validate and prepare every material before touching the authoritative project file.
        const material = [];
        for (const a of project.assets) {
            if (!a.embedded_data)
                continue;
            const match = /^data:([^;]+);base64,(.+)$/.exec(a.embedded_data);
            const bytes = Buffer.from(match[2], 'base64');
            if (bytes.length > 20 * 1024 * 1024)
                throw new StoreError('单个素材最大 20 MB', 413);
            if (!/^[a-f0-9]{64}$/.test(a.content_hash ?? '') || digest(bytes) !== a.content_hash)
                throw new StoreError('素材内容哈希不匹配：' + a.name, 422);
            if (!a.path.startsWith('assets/'))
                throw new StoreError('内嵌素材须保存在 assets/ 相对路径');
            material.push({ file: await this.owned(`${id}/${a.path}`, { createParents: true }), bytes });
        }
        const raw = pretty(project) + '\n', tmp = file + '.' + randomUUID() + '.tmp';
        try {
            for (const a of material) {
                let existing;
                try {
                    existing = await fs.readFile(a.file);
                }
                catch (e) {
                    if (e.code !== 'ENOENT')
                        throw e;
                }
                if (existing && digest(existing) !== digest(a.bytes))
                    throw new StoreError('素材相对路径已被其他内容占用，请重新定位该素材', 422);
                if (!existing)
                    await this.atomic(a.file, a.bytes);
            }
            if (prior !== null) {
                const snapshot = await this.owned(`${id}/snapshots/${hash}.json`, { createParents: true });
                await fs.writeFile(snapshot, prior, { flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST')
                    throw e; });
            }
            if (project.import_source?.original) {
                const source = await this.owned(`${id}/original.import.json`);
                await fs.writeFile(source, pretty(project.import_source.original) + '\n', { flag: 'wx' }).catch(e => { if (e.code !== 'EEXIST')
                    throw e; });
            }
            const handle = await fs.open(tmp, 'wx');
            try {
                await handle.writeFile(raw);
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            const latest = await getRaw();
            if ((latest === null ? null : digest(latest)) !== expectedHash)
                throw new StoreError('写入前检测到外部更新', 409, { disk_hash: latest === null ? null : digest(latest), disk_raw: latest });
            await fs.rename(tmp, file);
            return { hash: digest(raw), file, revision: project.revision };
        }
        finally {
            await fs.rm(tmp, { force: true });
        }
    }
    async atomic(file, data) { const tmp = file + '.' + randomUUID() + '.tmp'; try {
        const h = await fs.open(tmp, 'wx');
        try {
            await h.writeFile(data);
            await h.sync();
        }
        finally {
            await h.close();
        }
        await fs.rename(tmp, file);
    }
    finally {
        await fs.rm(tmp, { force: true });
    } }
    async media(id, relative) { this.validId(id); if (typeof relative !== 'string' || !relative.startsWith('assets/') || /[\\\x00:]/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..'))
        throw new StoreError('仅可读取项目素材'); return this.owned(`${id}/${relative}`); }
}
