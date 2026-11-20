// 项目音乐托管目录：<数据目录>/project-music/<项目>--<id>/<歌名>--<id前8位>/第NN轮/<标签>.<扩展名>
// 目录只由本模块创建（0700），不登记为素材根，候选版不进音乐库（SPEC 3.2）。
// 文件身份：保存 dev/ino/size/mtime 与 SHA-256；读取前核对，变了就拒绝，不悄悄换内容。
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {projectFolderName} from '../prompt-codex/pictures.mjs';
import {fail} from './model.mjs';

// 身份含 ctime：修改时间可以被改回原值，ctime 不能。任何写入或改属性都会让 ctime 变，变了就重新核对内容。
const stamp = s => ({dev: String(s.dev), ino: String(s.ino), size: s.size, mtimeMs: Math.round(s.mtimeMs), ctimeMs: Math.round(s.ctimeMs)});
const sameStamp = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
export const PEAK_COUNT = 300;

function segment(name, max = 60) {
  const clean = String(name).normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^[. ]+|[. ]+$/g, '');
  let out = '';
  for (const ch of clean) { if (Buffer.byteLength(out + ch) > max) break; out += ch; }
  return out.replace(/[. ]+$/g, '') || '未命名';
}
export const roundFolder = n => `第${String(n).padStart(2, '0')}轮`;

async function privateDir(dir) {
  await fs.mkdir(dir, {recursive: true, mode: 0o700});
  const st = await fs.lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) fail('MUSIC_STORAGE_INVALID', '项目音乐目录无效', 500);
  return dir;
}

export class MusicFiles {
  constructor(dataDir) {
    this.configured = path.join(dataDir, 'project-music');
    this.base = null;
  }

  async root() {
    if (this.base) {
      if (await fs.realpath(this.base).catch(() => null) !== this.base) fail('MUSIC_STORAGE_CHANGED', '项目音乐目录位置已变化，请核对数据目录', 409);
      return this.base;
    }
    await privateDir(this.configured);
    const real = await fs.realpath(this.configured);
    await privateDir(path.join(real, '.incoming'));
    this.base = real;
    return real;
  }

  // 相对路径 → 绝对路径，并确认没有越出托管目录、路径上没有符号链接。
  async resolve(rel) {
    const base = await this.root();
    if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.split('/').some(p => !p || p === '.' || p === '..')) fail('MUSIC_STORAGE_INVALID', '托管文件位置无效', 500);
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

  async songFolder(project, songId, songTitle) {
    const projectRel = await this.projectFolder(project);
    const rel = `${projectRel}/${segment(songTitle)}--${songId.slice(0, 8)}`;
    await privateDir(await this.resolve(rel));
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
    const safe = segment(stem, 80);
    for (let n = 1; n < 1000; n++) {
      const name = (n === 1 ? safe : `${safe}-${n}`) + ext;
      try {
        await fs.link(stage, path.join(folder, name));
      } catch (e) {
        if (e.code === 'EEXIST') continue;
        throw e;
      }
      await fs.unlink(stage);
      const handle = await fs.open(folder, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await handle.sync(); } finally { await handle.close(); }
      const file = path.join(folder, name);
      return {rel: `${folderRel}/${name}`, fileName: name, identity: stamp(await fs.lstat(file))};
    }
    fail('MUSIC_STORAGE_FULL', '同名文件过多，请换一个版本标签', 409);
  }

  async hashFile(handle) {
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({autoClose: false, start: 0})) hash.update(chunk);
    return hash.digest('hex');
  }

  // 打开一个托管文件：身份（含 ctime）一致直接用；任何一项变了都重算 SHA-256——内容一致就刷新身份照常用（只动了属性），
  // 内容变了就拒绝（包括同长度改写后再把修改时间改回原值）。旧记录没有 ctime，也会走一次哈希后补上。
  async open(rel, expected) {
    const file = await this.resolve(rel);
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
        if (st.size !== expected.identity.size || await this.hashFile(handle) !== expected.sha256) fail('MUSIC_FILE_CHANGED', '音频文件内容已变化，与上传时不一致；未播放或下载', 409);
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
