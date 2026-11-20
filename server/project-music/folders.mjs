// 项目音乐 ·「文件」区（SPEC 第十三节）：存储和传递用的文件夹，和「歌曲」（采用和对比）并列。
// 磁盘就是真相：personal_item/music/<项目>--<id>/<用户文件夹>/…，访达里看到的和页面一致，不另建表。
// 文件都在音乐库根目录「AI生成」下，由我们放进来的会立即登记；在访达里直接放进来的，等音乐库扫描登记。
// 复用生成视频的：文件夹命名规则、复制给剪辑软件、在访达中显示（同一个原生组件），以及上传的「登记 → 传内容 → 确认」三步。
// 不搬：缩略图、「成片」文件夹、人脸识别、和 Updream 的绑定。新加：波形、在列表里直接播放、加入歌曲。
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {folderName, nameKey} from '../project-videos/folders.mjs';
import {AUDIO, within} from '../fs-identity.mjs';
import {SONGS_FOLDER} from './files.mjs';
import * as M from './model.mjs';

const {fail} = M;
export const FILE_FORMATS = new Set([...AUDIO].filter(e => e !== 'ncm'));
const MAX_FOLDERS = 2000, MAX_DEPTH = 8, MAX_ITEMS = 2000, DESKTOP_LIMIT = 50, DESKTOP_TTL = 10 * 60 * 1000;
const extOf = name => path.extname(name).slice(1).toLowerCase();
const posixJoin = (...parts) => parts.filter(Boolean).join('/');

// 读路径：每一段都不能是空、点开头、.. 或含 / 和控制字符。访达里建的名字可能不合「新建」规则，读的时候照样接受。
function relPath(value, label = '位置') {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 4000 || path.isAbsolute(value) || value.includes('\\')) fail('INVALID_PATH', `${label}无效`);
  const parts = value.split('/');
  if (parts.some(p => !p || p.startsWith('.') || /[\u0000-\u001f]/.test(p))) fail('INVALID_PATH', `${label}无效`);
  return parts.join('/');
}

const unavailable = reason => ({available: false, code: 'DESKTOP_UNAVAILABLE', reason});

export class MusicFolders {
  constructor(store, {native = null, dataDir} = {}) {
    this.store = store;
    this.native = native;
    this.cacheDir = path.join(dataDir ?? store.lib.dataDir, 'project-music-cache', 'peaks');
    this.desktop = new Map();
    this.peakWork = Promise.resolve();
  }

  get db() { return this.store.db; }
  get files() { return this.store.files; }

  // ---------- 位置 ----------

  async base(projectId, {create = false} = {}) {
    const project = this.store.project(projectId);
    if (create) {
      await this.store.prepareRoot();
      const rel = await this.files.projectFolder(project);
      return {project, rel, dir: await this.files.resolve(rel)};
    }
    const rel = await this.files.findProjectFolder(project);
    return {project, rel, dir: rel ? await this.files.resolve(rel) : null};
  }

  // 逐段确认是真实目录、不是符号链接。「歌曲」是系统文件夹，只在 allowSongs 时可以进入。
  async folderAt(dir, rel, {allowSongs = false} = {}) {
    rel = relPath(rel, '文件夹');
    if (!allowSongs && rel.split('/')[0] === SONGS_FOLDER) fail('FOLDER_RESERVED', '「歌曲」是系统管理的文件夹，请到「歌曲」标签里操作', 409);
    let at = dir;
    for (const part of rel ? rel.split('/') : []) {
      at = path.join(at, part);
      const st = await fs.lstat(at).catch(() => null);
      if (!st) fail('FOLDER_NOT_FOUND', '这个文件夹不见了，可能在访达里改了名或挪走了；请刷新', 404);
      if (!st.isDirectory() || st.isSymbolicLink()) fail('FOLDER_NOT_FOUND', '这个位置不是文件夹', 404);
    }
    return {rel, abs: at};
  }

  async fileAt(projectId, value, {allowSongs = true} = {}) {
    const rel = relPath(value, '文件');
    if (!rel) fail('INVALID_PATH', '请选择文件');
    const {dir} = await this.base(projectId);
    if (!dir) fail('FILE_NOT_FOUND', '这个项目还没有音乐文件夹', 404);
    const folder = await this.folderAt(dir, path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel), {allowSongs});
    const file = path.join(folder.abs, path.posix.basename(rel));
    const st = await fs.lstat(file).catch(() => null);
    if (!st || !st.isFile() || st.isSymbolicLink()) fail('FILE_NOT_FOUND', '这个文件不见了，可能在访达里改了名或挪走了；请刷新', 404);
    return {rel, file, st, dir};
  }

  // ---------- 读：文件夹树和当前文件夹里的文件 ----------

  async walk(dir) {
    const folders = [];
    let truncated = false;
    const visit = async (abs, rel, depth) => {
      let entries;
      try { entries = await fs.readdir(abs, {withFileTypes: true}); } catch { return 0; }
      let n = 0;
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))) {
        if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if (!rel && e.name === SONGS_FOLDER) continue;
          if (folders.length >= MAX_FOLDERS || depth >= MAX_DEPTH) { truncated = true; continue; }
          const id = posixJoin(rel, e.name);
          const entry = {id, name: e.name.normalize('NFC'), parentId: rel || 'root', path: id, count: 0};
          folders.push(entry);
          entry.count = await visit(path.join(abs, e.name), id, depth + 1);
          n += entry.count;
        } else if (e.isFile() && FILE_FORMATS.has(extOf(e.name))) n++;
      }
      return n;
    };
    const rootCount = await visit(dir, '', 0);
    return {folders, rootCount, truncated};
  }

  versionsByAsset(projectId) {
    const map = new Map();
    const songs = new Map(this.db.prepare('SELECT id,data_json FROM project_music_songs WHERE project_id=?').all(projectId).map(r => [r.id, JSON.parse(r.data_json).title]));
    const rounds = new Map(this.db.prepare('SELECT id,round_no FROM project_music_rounds WHERE project_id=?').all(projectId).map(r => [r.id, Number(r.round_no)]));
    for (const r of this.db.prepare('SELECT id,song_id,round_id,data_json FROM project_music_versions WHERE project_id=?').all(projectId)) {
      const d = JSON.parse(r.data_json);
      if (!d.assetId) continue;
      const list = map.get(d.assetId) ?? [];
      list.push({versionId: r.id, songId: r.song_id, songTitle: songs.get(r.song_id) ?? '', roundNo: rounds.get(r.round_id) ?? null, label: d.label, status: d.status});
      map.set(d.assetId, list);
    }
    return map;
  }

  async list(projectId, folder = '') {
    const {project, dir} = await this.base(projectId);
    const songCount = Number(this.db.prepare('SELECT COUNT(*) n FROM project_music_songs WHERE project_id=?').get(projectId).n);
    const songsNode = {id: SONGS_FOLDER, name: SONGS_FOLDER, songCount, present: false};
    const empty = {projectId, projectName: project.name, folder: '', exists: false, folders: [], rootCount: 0, truncated: false, items: [], songs: songsNode};
    if (!dir) { if (folder) fail('FOLDER_NOT_FOUND', '这个项目还没有音乐文件夹', 404); return empty; }
    const {folders, rootCount, truncated} = await this.walk(dir);
    const here = await this.folderAt(dir, folder);
    songsNode.present = !!(await fs.lstat(path.join(dir, SONGS_FOLDER)).then(st => st.isDirectory() && !st.isSymbolicLink(), () => false));
    // 有歌却找不到「歌曲」文件夹：多半在访达里挪动或改名了，页面提示核对（同生成视频的「成片」）。
    songsNode.needsReview = !songsNode.present && !!this.db.prepare('SELECT id FROM project_music_versions WHERE project_id=? AND data_json LIKE ? LIMIT 1').get(projectId, '%"relativePath":"%');
    const used = this.versionsByAsset(projectId);
    const items = [];
    const entries = (await fs.readdir(here.abs, {withFileTypes: true})).filter(e => e.isFile() && !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    for (const e of entries.slice(0, MAX_ITEMS)) {
      const file = path.join(here.abs, e.name), st = await fs.lstat(file).catch(() => null);
      if (!st || !st.isFile()) continue;
      const ext = extOf(e.name), audio = FILE_FORMATS.has(ext), id = posixJoin(here.rel, e.name);
      const a = this.db.prepare('SELECT id,tags,duration,trashed FROM assets WHERE path=?').get(file);
      const asset = a && !a.trashed ? a : null;
      const q = `path=${encodeURIComponent(id)}`, base = `/api/project-music/projects/${projectId}/files`;
      items.push({
        id, name: e.name.normalize('NFC'), folder: here.rel, ext, bytes: st.size, modifiedAt: Math.round(st.mtimeMs), audio,
        addable: audio && M.FORMATS.has('.' + ext), inLibrary: !!asset, assetId: asset?.id ?? null, tags: asset ? JSON.parse(asset.tags) : [],
        durationMs: asset?.duration ? Math.round(asset.duration * 1000) : null, inSongs: asset ? used.get(asset.id) ?? [] : [],
        mediaUrl: audio ? `${base}/media?${q}` : null, downloadUrl: `${base}/media?${q}&download=1`, peaksUrl: audio ? `${base}/peaks?${q}` : null,
      });
    }
    return {projectId, projectName: project.name, folder: here.rel, exists: true, folders, rootCount, truncated, itemsTruncated: entries.length > MAX_ITEMS, items, songs: songsNode};
  }

  // 波形：按 位置 + dev/ino/大小/修改时间 缓存在数据目录里；文件变了自然重算。一次只解一个，免得同时起很多 ffmpeg。
  async peaks(projectId, value) {
    const {file, st} = await this.fileAt(projectId, value);
    if (!FILE_FORMATS.has(extOf(file))) fail('UNSUPPORTED_FORMAT', '只有音频文件有波形', 400);
    const key = createHash('sha256').update([file, st.dev, st.ino, st.size, Math.round(st.mtimeMs)].join('\0')).digest('hex');
    const cached = path.join(this.cacheDir, key + '.json');
    const hit = await fs.readFile(cached, 'utf8').then(JSON.parse, () => null);
    if (hit) return hit;
    const work = this.peakWork.then(() => this.files.analyze(file));
    this.peakWork = work.catch(() => {});
    const r = await work;
    const out = {peaks: r.peaks, durationMs: r.durationMs};
    if (r.peaks) {
      await fs.mkdir(this.cacheDir, {recursive: true, mode: 0o700});
      await fs.writeFile(cached + '.partial', JSON.stringify(out), {mode: 0o600});
      await fs.rename(cached + '.partial', cached);
    }
    return out;
  }

  async openFile(projectId, value) {
    const {file} = await this.fileAt(projectId, value);
    let handle;
    try {
      if (await fs.realpath(file) !== file) fail('FILE_NOT_FOUND', '文件位置已变化，未读取', 409);
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (e) {
      if (e.status) throw e;
      fail('FILE_NOT_FOUND', '这个文件暂时读不到', 404);
    }
    return {handle, path: file, downloadName: path.basename(file).normalize('NFC')};
  }

  // ---------- 写：文件夹 ----------

  newName(value, parent) {
    const name = folderName(typeof value === 'string' ? value.trim() : value);
    if (!parent && name === SONGS_FOLDER) fail('FOLDER_RESERVED', '「歌曲」是系统文件夹的名字，请换一个', 409);
    return name;
  }

  async assertFree(parentAbs, name, except = null) {
    const clash = (await fs.readdir(parentAbs)).find(n => nameKey(n) === nameKey(name) && n !== except);
    if (clash) fail('FOLDER_EXISTS', `这里已经有「${clash}」了，请换一个名字`, 409);
  }

  createFolder(projectId, input) {
    M.onlyKeys(input, ['parent', 'name', 'session']);
    return this.store.serial(async () => {
      const {dir} = await this.base(projectId, {create: true});
      const parent = await this.folderAt(dir, input.parent ?? '');
      const name = this.newName(input.name, parent.rel);
      await this.assertFree(parent.abs, name);
      try { await fs.mkdir(path.join(parent.abs, name), {mode: 0o700}); }
      catch (e) { if (e.code === 'EEXIST') fail('FOLDER_EXISTS', `这里已经有「${name}」了，请换一个名字`, 409); throw e; }
      return this.list(projectId, posixJoin(parent.rel, name));
    });
  }

  // 改名：磁盘上改名，再把音乐库里这个文件夹下的记录路径一起改掉（标签、项目关联和版本都跟着素材 ID 走，不丢）。
  renameFolder(projectId, input) {
    M.onlyKeys(input, ['path', 'name', 'session']);
    return this.store.serial(async () => {
      const {dir} = await this.base(projectId);
      if (!dir) fail('FOLDER_NOT_FOUND', '这个项目还没有音乐文件夹', 404);
      const from = await this.folderAt(dir, input.path);
      if (!from.rel) fail('FOLDER_RESERVED', '项目文件夹本身不能在这里改名', 409);
      const parentRel = path.posix.dirname(from.rel) === '.' ? '' : path.posix.dirname(from.rel);
      const name = this.newName(input.name, parentRel);
      const parentAbs = path.dirname(from.abs), target = path.join(parentAbs, name);
      if (name === path.basename(from.abs)) return this.list(projectId, from.rel);
      await this.assertFree(parentAbs, name, path.basename(from.abs));
      if (nameKey(name) !== nameKey(path.basename(from.abs)) && await fs.lstat(target).then(() => true, () => false)) fail('FOLDER_EXISTS', `这里已经有「${name}」了，请换一个名字`, 409);
      await fs.rename(from.abs, target);
      const root = this.store.lib.roots().find(r => within(r.path, from.abs));
      if (root) {
        const like = from.abs.replace(/[\\%_]/g, '\\$&') + '/%';
        const rows = this.db.prepare("SELECT id,path FROM assets WHERE root_id=? AND path LIKE ? ESCAPE '\\'").all(root.id, like);
        this.db.transaction(() => {
          for (const r of rows) this.db.prepare('UPDATE assets SET path=? WHERE id=? AND path=?').run(target + r.path.slice(from.abs.length), r.id, r.path);
        })();
        this.store.lib.directoryClassification?.sync?.(root.id);
        this.store.lib.onMetadataChanged?.(root.id);
      }
      return this.list(projectId, posixJoin(parentRel, name));
    });
  }

  // ---------- 上传到某个文件夹（同歌曲的三步；回执和歌曲的放在同一张回执表里，用 kind 区分） ----------

  fileReceipt(projectId, requestId) {
    return this.store.importRow(projectId, requestId, 'file');
  }

  receiptDTO(s) {
    const interrupted = s.status === 'uploading' && s.instance !== this.store.instance;
    return {
      id: s.id, kind: 'file', projectId: s.projectId, folder: s.folder, fileName: s.fileName, bytes: s.bytes,
      status: interrupted ? 'failed' : s.status, path: s.path ?? null, name: s.name ?? null, duplicates: s.duplicates ?? [],
      error: interrupted ? '上次上传被中断，没有自动重发；请重新选择文件上传' : s.error ?? null,
    };
  }

  receipt(projectId, requestId) { return this.receiptDTO(this.fileReceipt(projectId, requestId)); }

  startImport(projectId, input, author) {
    M.onlyKeys(input, ['requestId', 'folder', 'fileName', 'bytes', 'session']);
    this.store.project(projectId);
    const id = M.requestId(input.requestId);
    const folder = relPath(input.folder ?? '', '文件夹');
    if (folder.split('/')[0] === SONGS_FOLDER) fail('FOLDER_RESERVED', '「歌曲」是系统管理的文件夹；要放进某首歌，请用「上传新一轮」或「加入歌曲」', 409);
    const name = M.text(input.fileName, '文件名', 240, {required: true}).normalize('NFC');
    if (/^[. ]|[<>:"/\\|?*\u0000-\u001f]|[. ]$/.test(name)) fail('INVALID_FILE', '文件名无效');
    const ext = extOf(name);
    if (!FILE_FORMATS.has(ext)) fail('UNSUPPORTED_FORMAT', `「文件」里只放音频：${[...FILE_FORMATS].join('、')}`);
    if (!Number.isSafeInteger(input.bytes) || input.bytes < 1) fail('INVALID_FILE', '文件长度无效');
    if (input.bytes > M.MAX_BYTES) fail('FILE_TOO_LARGE', '单个文件不能超过 200MB', 413);
    const args = M.digest({kind: 'file', folder, name, bytes: input.bytes});
    const existing = this.db.prepare('SELECT * FROM project_music_imports WHERE id=?').get(id);
    if (existing) {
      const s = JSON.parse(existing.data_json);
      if (existing.project_id !== projectId || s.args !== args) fail('REQUEST_ID_CONFLICT', '请求编号已用于其他文件', 409);
      return this.receiptDTO(s);
    }
    const at = M.now();
    const s = {id, kind: 'file', projectId, folder, fileName: name, ext: '.' + ext, bytes: input.bytes, args, status: 'waiting', instance: this.store.instance, uploadedBy: author, createdAt: at};
    this.db.prepare('INSERT INTO project_music_imports(id,project_id,data_json,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, projectId, M.canonical(s), at, at);
    return this.receiptDTO(s);
  }

  async upload(projectId, requestId, stream) {
    const store = this.store, s = this.fileReceipt(projectId, requestId);
    if (s.status !== 'waiting' || store.running.has(s.id)) fail('IMPORT_BUSY', '这份文件已经接收过或正在接收；请查原回执，不要重复发送', 409);
    store.running.add(s.id);
    s.status = 'uploading'; s.instance = store.instance; store.persistImport(s);
    try {
      s.stage = await this.files.stagePath(s.id);
      const got = await this.files.receive(stream, s.stage, s.bytes, {check: () => { if (store.closing) fail('MUSIC_CLOSING', '项目音乐正在关闭', 503); }});
      s.sha256 = got.sha256; s.stageStat = got.stat;
      return await store.serial(async () => {
        // 同一个文件夹里已经有完全相同的内容：先问（仍然保留 / 取消），不悄悄多一份。
        const {dir} = await this.base(projectId, {create: true});
        const here = await this.folderAt(dir, s.folder);
        const same = [];
        for (const e of await fs.readdir(here.abs, {withFileTypes: true})) {
          if (!e.isFile() || e.name.startsWith('.')) continue;
          const f = path.join(here.abs, e.name), st = await fs.lstat(f);
          if (st.size === s.bytes && await this.hash(f) === s.sha256) same.push(e.name.normalize('NFC'));
        }
        if (same.length) { s.status = 'duplicate'; s.duplicates = same; store.persistImport(s); return this.receiptDTO(s); }
        return this.place(s);
      });
    } catch (e) {
      await store.failImport(s, e);
      throw e;
    } finally {
      store.running.delete(s.id);
    }
  }

  async resolve(projectId, requestId, input) {
    M.onlyKeys(input, ['choice']);
    const store = this.store;
    return store.serial(async () => {
      const s = this.fileReceipt(projectId, requestId);
      if (s.status === 'ready' || s.status === 'cancelled') return this.receiptDTO(s);
      if (s.status !== 'duplicate' || store.running.has(s.id)) fail('IMPORT_BUSY', '这次上传不在等待选择的状态', 409);
      if (input.choice === 'cancel') {
        await fs.rm(s.stage, {force: true}).catch(() => {});
        s.status = 'cancelled'; s.error = null; delete s.stage; store.persistImport(s);
        return this.receiptDTO(s);
      }
      if (input.choice !== 'keep') fail('INVALID_CHOICE', '请选择「仍然保留」或「取消」');
      store.running.add(s.id);
      try { return await this.place(s); }
      catch (e) { await store.failImport(s, e); throw e; }
      finally { store.running.delete(s.id); }
    });
  }

  async hash(file) {
    const h = createHash('sha256');
    for await (const chunk of (await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)).createReadStream()) h.update(chunk);
    return h.digest('hex');
  }

  // 放进文件夹：重名不覆盖，按「名字-2」往下排；立即登记进音乐库。
  async place(s) {
    const store = this.store;
    const st = await fs.lstat(s.stage).catch(() => null);
    if (!st || String(st.dev) !== s.stageStat.dev || String(st.ino) !== s.stageStat.ino || st.size !== s.bytes) fail('IMPORT_STAGE_CHANGED', '接收的临时文件已变化，请重新上传', 409);
    const {dir, rel} = await this.base(s.projectId, {create: true});
    const here = await this.folderAt(dir, s.folder);
    const root = await store.prepareRoot();
    const stem = path.basename(s.fileName, path.extname(s.fileName));
    const placed = await this.files.publish(s.stage, posixJoin(rel, here.rel), stem, s.ext);
    const file = await this.files.resolve(placed.rel), fst = await fs.lstat(file);
    let assetId;
    try {
      this.db.transaction(() => {
        assetId = store.indexAsset(root, file, s.sha256, fst);
        s.status = 'ready'; s.path = posixJoin(here.rel, placed.fileName); s.name = placed.fileName; s.assetId = assetId; s.error = null; delete s.stage;
        store.persistImport(s);
      })();
    } catch (e) {
      await fs.rm(file, {force: true}).catch(() => {});
      throw e;
    }
    store.lib.enqueue?.(assetId);
    return this.receiptDTO(s);
  }

  // ---------- 加入歌曲：把「文件」里的一个音频变成某首歌某一轮的一个版本（文件不挪，版本复用这条音乐库记录） ----------

  addToSong(projectId, input, author) {
    M.onlyKeys(input, ['requestId', 'path', 'roundId', 'label', 'keep', 'session']);
    const requestId = M.requestId(input.requestId);
    const store = this.store;
    return store.serial(async () => {
      const done = this.db.prepare('SELECT song_id,data_json FROM project_music_versions WHERE project_id=? AND data_json LIKE ?').all(projectId, `%"importRequestId":"${requestId}"%`)
        .find(r => JSON.parse(r.data_json).importRequestId === requestId);
      if (done) return store.song(projectId, done.song_id);
      const round = store.roundRow(projectId, input.roundId), song = store.songRow(projectId, round.song_id);
      if (song.data.status !== 'active') fail('SONG_NOT_ACTIVE', '这首歌不在进行中，不能再加版本', 409);
      const {file, st} = await this.fileAt(projectId, input.path, {allowSongs: false});
      const ext = '.' + extOf(file);
      if (!M.FORMATS.has(ext)) fail('UNSUPPORTED_FORMAT', '加入歌曲只支持 mp3、wav、m4a、flac', 400);
      if (st.size > M.MAX_BYTES) fail('FILE_TOO_LARGE', '单个文件不能超过 200MB', 413);
      const sha256 = await this.hash(file);
      const opened = await this.files.openPath(file, {identity: null, sha256});
      await opened.handle.close();
      const dups = this.db.prepare('SELECT * FROM project_music_versions WHERE project_id=? AND sha256=?').all(projectId, sha256);
      if (dups.length && input.keep !== true) {
        const list = dups.map(r => {
          const d = JSON.parse(r.data_json), t = this.db.prepare('SELECT data_json FROM project_music_songs WHERE id=?').get(r.song_id), n = this.db.prepare('SELECT round_no FROM project_music_rounds WHERE id=?').get(r.round_id);
          return {versionId: r.id, songTitle: t ? JSON.parse(t.data_json).title : '', roundNo: n ? Number(n.round_no) : null, label: d.label, status: d.status};
        });
        fail('DUPLICATE_IN_PROJECT', `项目里已有同样内容：${list.map(d => `「${d.songTitle}」第 ${d.roundNo} 轮 ${d.label}`).join('、')}；仍要加入请带 keep:true`, 409, {duplicates: list});
      }
      let label = input.label == null || input.label === '' ? null : M.label(input.label);
      if (label && store.labelTaken(round.id, label)) fail('LABEL_TAKEN', '这一轮已有同名版本标签', 409);
      if (!label && !/suno/i.test(round.data.prompt?.tool ?? '')) { try { label = M.label(path.basename(file, ext).slice(0, 40).trim()); } catch { label = null; } if (label && store.labelTaken(round.id, label)) label = null; }
      if (!label) label = store.nextLetter(round.id);
      const analysis = await this.files.analyze(file);
      const root = this.store.lib.roots().find(r => within(r.path, file)) ?? await store.prepareRoot();
      const at = M.now(), id = M.newId();
      let assetId;
      this.db.transaction(() => {
        const existing = this.db.prepare('SELECT id,trashed FROM assets WHERE path=?').get(file);
        assetId = existing && !existing.trashed ? existing.id : store.indexAsset(root, file, sha256, st);
        if (existing && !existing.trashed) this.db.prepare("UPDATE assets SET sha256=? WHERE id=? AND (sha256 IS NULL OR sha256='')").run(sha256, assetId);
        store.insertVersion(id, {projectId, songId: song.id, sha256}, round, {
          label, originalName: path.basename(file).normalize('NFC'), fileName: path.basename(file).normalize('NFC'), format: M.FORMATS.get(ext), bytes: st.size,
          durationMs: analysis.durationMs, peaks: analysis.peaks, loudnessDb: analysis.loudnessDb, status: 'candidate', note: '', rejectedAt: null,
          uploadedBy: author, importRequestId: requestId, storage: 'library', relativePath: null, reused: true, identity: opened.refreshed, assetId, addedFrom: 'files',
        }, at);
      })();
      store.queueTags(assetId);
      return store.song(projectId, song.id);
    });
  }

  // ---------- 复制给剪辑软件、在访达中显示（共用生成视频的原生组件） ----------

  async capabilities(projectId) {
    this.store.project(projectId);
    if (!this.native) return {version: 1, maxSelection: DESKTOP_LIMIT, clipboard: unavailable('本机桌面连接不可用'), revealMany: unavailable('本机桌面连接不可用')};
    const cap = await this.native.capabilities().catch(() => null);
    return {version: 1, maxSelection: DESKTOP_LIMIT, clipboard: cap?.clipboard ?? unavailable('本机桌面连接不可用'), revealMany: cap?.revealMany ?? unavailable('本机桌面连接不可用')};
  }

  // 同一个请求编号只执行一次：响应丢了，用同一编号再发会拿到原来的结果（只在本次服务运行期间记住）。
  once(projectId, action, requestId, fn) {
    const key = `${projectId}:${action}:${M.requestId(requestId)}`;
    const now = Date.now();
    for (const [k, v] of this.desktop) if (v.at < now - DESKTOP_TTL) this.desktop.delete(k);
    const hit = this.desktop.get(key);
    if (hit) return hit.work;
    const work = Promise.resolve().then(fn);
    this.desktop.set(key, {at: now, work});
    work.catch(() => this.desktop.delete(key));
    return work;
  }

  async selected(projectId, paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > DESKTOP_LIMIT) fail('FILE_SELECTION_INVALID', `请选择 1 至 ${DESKTOP_LIMIT} 个文件`);
    const out = [], seen = new Set();
    for (const p of paths) {
      const {file, st} = await this.fileAt(projectId, p);
      const key = st.dev + ':' + st.ino;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({file, identity: [st.dev, st.ino, st.size, st.mtimeMs].join(':')});
    }
    return out;
  }

  async recheck(items) {
    for (const x of items) {
      const st = await fs.lstat(x.file).catch(() => null);
      if (!st || !st.isFile() || [st.dev, st.ino, st.size, st.mtimeMs].join(':') !== x.identity || await fs.realpath(x.file) !== x.file) fail('PREVIEW_STALE', '文件在核对后变化了，请刷新后再试', 409);
    }
  }

  async requireNative(projectId, key) {
    const cap = (await this.capabilities(projectId))[key];
    if (!cap.available) fail(cap.code || 'DESKTOP_UNAVAILABLE', cap.reason || '本机桌面连接不可用', 409);
  }

  clipboard(projectId, input) {
    M.onlyKeys(input, ['requestId', 'paths']);
    return this.once(projectId, 'clipboard', input.requestId, async () => {
      await this.requireNative(projectId, 'clipboard');
      const items = await this.selected(projectId, input.paths);
      const expectedChangeCount = await this.native.clipboardVersion();
      const ack = await this.native.copyFiles(items.map(x => x.file), {expectedChangeCount, beforeDispatch: () => this.recheck(items)}).catch(e => {
        if (e.code === 'CLIPBOARD_CHANGED') fail('CLIPBOARD_CHANGED', '剪贴板在核对期间已变化，没有覆盖新内容；请再点一次', 409);
        throw e;
      });
      return {status: 'completed', count: ack.count, ack: ack.ack};
    });
  }

  // 在访达中显示：给文件就选中这些文件；给文件夹（'' 是项目文件夹，「歌曲」也可以）就打开它。
  reveal(projectId, input) {
    M.onlyKeys(input, ['requestId', 'paths', 'folder']);
    return this.once(projectId, 'reveal', input.requestId, async () => {
      await this.requireNative(projectId, 'revealMany');
      if (input.paths !== undefined) {
        const items = await this.selected(projectId, input.paths);
        const ack = await this.native.revealFiles(items.map(x => x.file), {beforeDispatch: () => this.recheck(items)});
        return {status: 'completed', count: ack.count, ack: ack.ack};
      }
      const {dir} = await this.base(projectId, {create: true});
      const at = await this.folderAt(dir, input.folder ?? '', {allowSongs: true});
      const st = await fs.lstat(at.abs);
      const ack = await this.native.openFolder(at.abs, {identity: {dev: String(st.dev), ino: String(st.ino)}});
      return {status: 'completed', count: 1, ack: ack.ack};
    });
  }
}
