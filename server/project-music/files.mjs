import {syncDir} from '../fs-platform.mjs';
// 项目音乐文件（PR3，SPEC 第十一节）：<personal_item>/music/<项目>--<id>/歌曲/<歌名>/第NN轮/<歌名>-第NN轮-<标签>.<扩展名>
// personal_item/music 由 store 登记成音乐库根目录（显示名「AI生成」），全部版本都进全库索引。
// PR1、PR2 时期的旧位置 <数据目录>/project-music/… 只读：用来搬迁，旧副本等用户确认后再移到废纸篓。
// 文件身份：保存 dev/ino/size/mtime/ctime 与 SHA-256；读取前核对，变了就拒绝，不悄悄换内容。
import fs from '../fs-platform.mjs';
import fsSync from 'node:fs';
import path from 'node:path';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnMedia as spawn} from '../media-process.mjs';
import {projectFolderName} from '../prompt-codex/pictures.mjs';
import {fail} from './model.mjs';

// 身份含 ctime：修改时间可以被改回原值，ctime 不能。任何写入或改属性都会让 ctime 变，变了就重新核对内容。
export const stamp = s => ({dev: String(s.dev), ino: String(s.ino), size: s.size, mtimeMs: Math.round(s.mtimeMs), ctimeMs: Math.round(s.ctimeMs)});
const sameStamp = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
export const PEAK_COUNT = 300;

function segment(name, max = 60) {
  const clean = String(name).normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^[. ]+|[. ]+$/g, '');
  let out = '';
  for (const ch of clean) { if (Buffer.byteLength(out + ch) > max) break; out += ch; }
  return out.replace(/[. ]+$/g, '') || '未命名';
}
export const roundFolder = n => `第${String(n).padStart(2, '0')}轮`;
export const SONGS_FOLDER = '歌曲';
export {segment};

async function privateDir(dir) {
  await fs.mkdir(dir, {recursive: true, mode: 0o700});
  const st = await fs.lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) fail('MUSIC_STORAGE_INVALID', '项目音乐目录无效', 500);
  return dir;
}

const validRel = rel => typeof rel === 'string' && !!rel && !path.isAbsolute(rel) && !rel.split('/').some(p => !p || p === '.' || p === '..');

export class MusicFiles {
  constructor(dataDir, directory) {
    this.legacyConfigured = path.join(dataDir, 'project-music');
    this.configured = path.resolve(directory);
    this.base = null;
  }

  // 新位置：personal_item/music。上级目录按真实路径定位一次，之后位置变了就拒绝写入。目录本身不能是符号链接。
  async root() {
    if (this.base) {
      if (await fs.realpath(this.base).catch(() => null) !== this.base) fail('MUSIC_STORAGE_CHANGED', '音乐目录位置已变化，请核对 personal_item/music', 409);
      return this.base;
    }
    const parent = path.dirname(this.configured);
    await fs.mkdir(parent, {recursive: true, mode: 0o700});
    const canonical = path.join(await fs.realpath(parent), path.basename(this.configured));
    await privateDir(canonical);
    if (await fs.realpath(canonical) !== canonical) fail('MUSIC_STORAGE_INVALID', '音乐目录不能是符号链接', 409);
    await privateDir(path.join(canonical, '.incoming'));
    this.base = canonical;
    return canonical;
  }

  // 音乐目录的真实路径（不创建）：还没解析过时同步解析一次，目录不存在返回 null。
  baseSync() {
    if (this.base) return this.base;
    try { return fsSync.realpathSync(this.configured); } catch { return null; }
  }

  // 只用于展示和比较的位置（不创建目录）。
  expectedPath(rel) {
    if (!validRel(rel)) return null;
    let base = this.base;
    if (!base) { try { base = fsSync.realpathSync(this.configured); } catch { return null; } }
    return path.join(base, ...rel.split('/'));
  }

  // 相对路径 → 绝对路径，并确认没有越出音乐目录。
  async resolve(rel) {
    const base = await this.root();
    if (!validRel(rel)) fail('MUSIC_STORAGE_INVALID', '音乐文件位置无效', 500);
    return path.join(base, ...rel.split('/'));
  }

  // 旧位置（PR1、PR2）：只读，不存在就返回 null，不新建。
  async legacyRoot() {
    const real = await fs.realpath(this.legacyConfigured).catch(() => null);
    if (!real) return null;
    const st = await fs.lstat(real);
    return st.isDirectory() ? real : null;
  }

  async legacyResolve(rel) {
    const base = await this.legacyRoot();
    if (!base) fail('MUSIC_FILE_MISSING', '旧的项目音乐目录不见了；记录保留', 404);
    if (!validRel(rel)) fail('MUSIC_STORAGE_INVALID', '旧文件位置无效', 500);
    return path.join(base, ...rel.split('/'));
  }

  async projectFolder(project) {
    const base = await this.root();
    const suffix = '--' + project.id.toLowerCase();
    const found = (await fs.readdir(base, {withFileTypes: true})).filter(e => e.isDirectory() && e.name.endsWith(suffix));
    if (found.length > 1) fail('MUSIC_STORAGE_CHANGED', '当前项目有多个音乐目录，请先核对', 409);
    const name = found[0]?.name ?? projectFolderName(project);
    await privateDir(path.join(base, name));
    return name;
  }

  // 只查不建：项目还没有音乐文件夹时返回 null。
  async findProjectFolder(project) {
    const base = await this.root();
    const suffix = '--' + project.id.toLowerCase();
    const found = (await fs.readdir(base, {withFileTypes: true})).filter(e => e.isDirectory() && e.name.endsWith(suffix));
    if (found.length > 1) fail('MUSIC_STORAGE_CHANGED', '当前项目有多个音乐目录，请先核对', 409);
    return found[0]?.name ?? null;
  }

  // 歌曲文件夹：<项目>/歌曲/<名字>。名字由 store 选好（同项目里重名时加「 (2)」）。
  async songFolder(project, name) {
    const projectRel = await this.projectFolder(project);
    await privateDir(await this.resolve(`${projectRel}/${SONGS_FOLDER}`));
    const rel = `${projectRel}/${SONGS_FOLDER}/${segment(name, 120)}`;
    await privateDir(await this.resolve(rel));
    return rel;
  }

  async ensureFolder(rel) {
    const dir = await this.resolve(rel);
    await privateDir(dir);
    return rel;
  }

  async stagePath(requestId) {
    return path.join(await this.root(), '.incoming', requestId + '.partial');
  }

  // 接收原始字节：独占新建、边写边算 SHA-256；长度必须与登记时一致。
  async receive(stream, stage, expectedBytes, {check = () => {}} = {}) {
    await fs.rm(stage, {force: true});
    const handle = await fs.open(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of stream) {
        check();
        bytes += chunk.length;
        if (bytes > expectedBytes) fail('INVALID_LENGTH', '接收内容超出所选文件的长度', 409);
        await handle.write(chunk);
        hash.update(chunk);
      }
      if (bytes !== expectedBytes) fail('INVALID_LENGTH', '文件没有完整接收，请重新上传', 409);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return {sha256: hash.digest('hex'), bytes, stat: stamp(await fs.lstat(stage))};
  }

  // 用硬链接落位：目标已存在时 link 会失败，不会覆盖已有文件。
  async publish(stage, folderRel, stem, ext) {
    const folder = await this.resolve(folderRel);
    await privateDir(folder);
    if (await fs.realpath(folder) !== folder) fail('MUSIC_STORAGE_CHANGED', '轮次目录不能是符号链接', 409);
    const safe = segment(stem, 160);
    for (let n = 1; n < 1000; n++) {
      const name = (n === 1 ? safe : `${safe}-${n}`) + ext;
      try {
        await fs.link(stage, path.join(folder, name));
      } catch (e) {
        if (e.code === 'EEXIST') continue;
        // 旧版本留下的暂存文件在数据目录里，可能和 personal_item 不在同一个磁盘：改为独占复制。
        if (e.code !== 'EXDEV') throw e;
        try { await fs.copyFile(stage, path.join(folder, name), constants.COPYFILE_EXCL); }
        catch (c) { if (c.code === 'EEXIST') continue; throw c; }
        if ((await fs.lstat(path.join(folder, name))).size !== (await fs.lstat(stage)).size) {
          await fs.rm(path.join(folder, name), {force: true});
          fail('MUSIC_STORAGE_CHANGED', '复制到音乐目录时长度不一致，已撤回', 409);
        }
      }
      await fs.unlink(stage);
      await syncDir(folder,{flags:constants.O_RDONLY|constants.O_DIRECTORY});
      const file = path.join(folder, name);
      return {rel: `${folderRel}/${name}`, fileName: name, identity: stamp(await fs.lstat(file))};
    }
    fail('MUSIC_STORAGE_FULL', '同名文件过多，请换一个版本标签', 409);
  }

  // 中断恢复（P3-1）：上次已经把文件落到目标位置、还没来得及登记就中断了。按 publish 的命名规则找同名（含 -2、-3…）的文件，
  // 内容的 SHA-256 一致、不是符号链接、也不在 skip 里（别的版本已经在用的位置），就认领它，不再复制出新的 -N 副本。
  async adopt(folderRel, stem, ext, sha256, skip = new Set()) {
    const folder = await this.resolve(folderRel);
    const safe = segment(stem, 160);
    for (let n = 1; n < 1000; n++) {
      const name = (n === 1 ? safe : `${safe}-${n}`) + ext, rel = `${folderRel}/${name}`, file = path.join(folder, name);
      const st = await fs.lstat(file).catch(() => null);
      if (!st) return null;
      if (!st.isFile() || st.isSymbolicLink() || skip.has(rel)) continue;
      let handle;
      try {
        handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        if (await this.hashFile(handle) === sha256) return {rel, fileName: name, identity: stamp(await handle.stat())};
      } catch { /* 读不了就不认领 */ } finally { await handle?.close(); }
    }
    return null;
  }

  async hashFile(handle) {
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({autoClose: false, start: 0})) hash.update(chunk);
    return hash.digest('hex');
  }

  // 打开一个托管文件：身份（含 ctime）一致直接用；任何一项变了都重算 SHA-256——内容一致就刷新身份照常用（只动了属性），
  // 内容变了就拒绝（包括同长度改写后再把修改时间改回原值）。旧记录没有 ctime，也会走一次哈希后补上。
  async open(rel, expected) { return this.openPath(await this.resolve(rel), expected); }
  async openLegacy(rel, expected) { return this.openPath(await this.legacyResolve(rel), expected); }

  // expected.identity 为空时一定重算 SHA-256（比如复用音乐库里已有的文件）。
  async openPath(file, expected) {
    let handle;
    try {
      if (await fs.realpath(file) !== file) fail('MUSIC_FILE_CHANGED', '音频文件位置已变化，未读取', 409);
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (e) {
      if (e.code === 'ENOENT') fail('MUSIC_FILE_MISSING', '音频文件不见了；记录保留，请重新上传', 404);
      if (e.status) throw e;
      fail('MUSIC_FILE_UNREADABLE', '音频文件暂时无法读取', 409);
    }
    try {
      const st = stamp(await handle.stat());
      let refreshed = null;
      if (!sameStamp(st, expected.identity)) {
        if ((expected.identity && st.size !== expected.identity.size) || await this.hashFile(handle) !== expected.sha256) fail('MUSIC_FILE_CHANGED', '音频文件内容已变化，与上传时不一致；未播放或下载', 409);
        refreshed = st;
      }
      return {handle, path: file, refreshed};
    } catch (e) {
      await handle.close();
      throw e;
    }
  }

  // 波形峰值与响度估计。ffmpeg 不可用时返回空值，不影响上传本身。
  async analyze(file) {
    const result = {durationMs: null, peaks: null, loudnessDb: null};
    const pcm = await decode(file).catch(() => null);
    if (!pcm || !pcm.length) return result;
    const rate = 11025;
    result.durationMs = Math.round(pcm.length / rate * 1000);
    const peaks = new Array(PEAK_COUNT).fill(0);
    const per = pcm.length / PEAK_COUNT;
    for (let i = 0; i < PEAK_COUNT; i++) {
      let max = 0;
      const end = Math.min(pcm.length, Math.floor((i + 1) * per));
      for (let j = Math.floor(i * per); j < end; j++) { const v = Math.abs(pcm[j]); if (v > max) max = v; }
      peaks[i] = Math.round(max / 32768 * 1000);
    }
    const top = Math.max(1, ...peaks);
    result.peaks = peaks.map(v => Math.round(v / top * 1000));
    // 400ms 块 RMS，丢掉 -60 dBFS 以下的静音块，再取能量均值。只用于两版音量对齐，不等于 LUFS。
    const block = Math.round(rate * 0.4);
    let energy = 0, blocks = 0;
    for (let i = 0; i + block <= pcm.length; i += block) {
      let sum = 0;
      for (let j = i; j < i + block; j++) { const v = pcm[j] / 32768; sum += v * v; }
      const ms = sum / block;
      if (ms > 1e-6) { energy += ms; blocks++; }
    }
    if (blocks) result.loudnessDb = Math.round(10 * Math.log10(energy / blocks) * 10) / 10;
    return result;
  }
}

function decode(file) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-vn', '-ac', '1', '-ar', '11025', '-f', 's16le', '-'], {stdio: ['ignore', 'pipe', 'ignore']});
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.stdout.on('data', b => { size += b.length; if (size > 64 * 1024 * 1024) child.kill('SIGKILL'); else chunks.push(b); });
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(Error('ffmpeg 解码失败'));
      const buf = Buffer.concat(chunks);
      const even = buf.length - (buf.length % 2);
      resolve(new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + even)));
    });
  });
}
