// 访达右键收纳 → 项目音乐（SPEC 第十二节，加第十三节的扩展）。
// 给 FileIntake.context() 用的适配器，形状照 ManagedIntakeCatalog.bind()：批次回执、kick/process/resolve/reconcile/retry 都复用收纳模块。
// 两种去处：
//   文件（默认）：{kind:'music', scope:'project', projectId, musicFolder}，和收视频一样放进「文件」下的某个文件夹；
//   歌曲：{kind:'music', scope:'project', projectId, songId | newSongTitle, roundId | newRound:true, roundPrompt?}。
// 收纳端和项目音乐端的不一致（第十二节末）在这里对齐：
//   - 重名：import / rename 对应「仍然保留」(keep)，cancel 对应取消；不提供 reuse 和 overwrite；
//   - retry 取消还在 waiting 的回执：项目音乐只允许 duplicate 时取消，这里补上 waiting 的取消；
//   - reconcile 要读的 published、instance 在回执里补齐；
//   - 作者显式记成用户（来自访达）；
//   - 直接调 ProjectMusic 会绕过 router 的 track()，这里自己补上；
//   - 移动模式下按音乐库记录（assetId）核对结果文件，读文件用 files.openPath 的身份核对。
import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {canonical} from '../project-assets/model.mjs';
import {nameKey} from '../project-videos/folders.mjs';
import {within} from '../fs-identity.mjs';
import {SONGS_FOLDER, stamp} from './files.mjs';
import * as M from './model.mjs';
import {splitSunoPrompt} from './shared/prompt-split.mjs';

const {fail} = M;
const KEYS = ['kind', 'scope', 'projectId', 'fileName', 'musicFolder', 'songId', 'newSongTitle', 'roundId', 'newRound', 'roundPrompt'];
// 同一批里「新开一轮」「新建一首」要固定成同一个编号：重试同一批不会多开一轮。
function derivedId(...parts) {
  const h = createHash('sha256').update(parts.join('\u0000')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(8 | (parseInt(h[16], 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const intakeAuthor = () => ({kind: 'user', at: M.now(), via: 'finder'});
// 文件名认歌：去掉「(1)」这类编号、扩展名和所有空白，和歌名完全相同才算（SPEC 12.1）。不猜。
export const songKey = name => String(name).normalize('NFKC').replace(/\.[^.]+$/, '').replace(/[（(]\s*\d+\s*[)）]/g, '').replace(/\s+/g, '').toLowerCase();

export class ProjectMusicIntake {
  constructor(store, folders, {withActivity = fn => fn()} = {}) {
    this.store = store;
    this.folders = folders;
    this.withActivity = withActivity;
  }

  get db() { return this.store.db; }

  // ---------- 目标 ----------

  destination(value) {
    if (!value || typeof value !== 'object' || value.kind !== 'music' || value.scope !== 'project') fail('INTAKE_INVALID_INPUT', '项目音乐目标无效', 400);
    const extra = Object.keys(value).filter(k => !KEYS.includes(k));
    if (extra.length) fail('INTAKE_INVALID_INPUT', '项目音乐目标含不支持的字段：' + extra.join('、'), 400);
    if (!M.idOK(value.projectId)) fail('INTAKE_INVALID_INPUT', '请选择项目', 400);
    const d = {kind: 'music', scope: 'project', projectId: value.projectId.toLowerCase()};
    const toSong = value.songId !== undefined || value.newSongTitle !== undefined;
    if (toSong) {
      if (value.musicFolder !== undefined) fail('INTAKE_INVALID_INPUT', '一个文件只能放进「文件」或「歌曲」中的一处', 400);
      // 「按项目改名」对音乐不生效，歌曲的版本文件按版本号命名，不收自定义文件名。
      if (value.fileName !== undefined) fail('INTAKE_INVALID_INPUT', '放进歌曲的版本按「歌名-第几轮-版本」命名，不能改文件名', 400);
      if (value.songId !== undefined) {
        if (value.newSongTitle !== undefined || !M.idOK(value.songId)) fail('INTAKE_INVALID_INPUT', '请选择一首歌，或新建一首', 400);
        d.songId = value.songId.toLowerCase();
      } else d.newSongTitle = M.title(value.newSongTitle, '新歌名');
      if (value.newRound === true || d.newSongTitle) {
        if (value.roundId !== undefined) fail('INTAKE_INVALID_INPUT', '选了「新开一轮」就不能再指定轮次', 400);
        d.newRound = true;
        const p = M.text(value.roundPrompt ?? '', '本轮提示词', 20000).trim();
        if (p) d.roundPrompt = p;
      } else {
        if (value.newRound !== undefined || !M.idOK(value.roundId)) fail('INTAKE_INVALID_INPUT', '请选择放进哪一轮，或新开一轮', 400);
        if (value.roundPrompt !== undefined) fail('INTAKE_INVALID_INPUT', '本轮提示词只在新开一轮时填写', 400);
        d.roundId = value.roundId.toLowerCase();
      }
    } else {
      if (['roundId', 'newRound', 'roundPrompt'].some(k => value[k] !== undefined)) fail('INTAKE_INVALID_INPUT', '放进「文件」时不用选轮次', 400);
      const folder = value.musicFolder ?? '';
      if (typeof folder !== 'string' || folder.length > 4000 || folder.split('/')[0] === SONGS_FOLDER || (folder && folder.split('/').some(p => !p || p.startsWith('.') || /[\u0000-\u001f\\]/.test(p)))) fail('INTAKE_INVALID_INPUT', '「文件」里的文件夹无效', 400);
      d.musicFolder = folder;
      if (value.fileName !== undefined) d.fileName = value.fileName;
    }
    return d;
  }

  // 放进歌曲只收 mp3、wav、m4a、flac；确认收纳时就说清楚，不等到后台处理才失败。
  checkFile(value, file) {
    const d = this.destination(value);
    if (d.musicFolder !== undefined) return;
    if (!M.FORMATS.has(path.extname(file.name).toLowerCase())) fail('UNSUPPORTED_FORMAT', `「${file.name}」：${M.SONG_FORMAT_MESSAGE}；也可以先放进「文件」`, 400);
    if (file.bytes > M.MAX_BYTES) fail('FILE_TOO_LARGE', `「${file.name}」超过 200MB，不能放进歌曲`, 413);
  }

  groupKey(d) { return d.songId ? `${d.projectId}:${d.songId}` : `${d.projectId}:new:${nameKey(d.newSongTitle)}`; }

  // 确认收纳时：同一首歌的「新开一轮」整批只开一轮（一次收进的多个文件是同一轮的多个版本，SPEC 12.5），新歌只建一首。
  plan(destinations, batchId) {
    const groups = new Map();
    for (const raw of destinations) {
      if (raw?.kind !== 'music' || raw?.scope !== 'project') continue;
      const d = this.destination(raw);
      if (!d.newRound) continue;
      const key = this.groupKey(d), seen = groups.get(key);
      if (seen && (seen.roundPrompt ?? '') !== (d.roundPrompt ?? '')) fail('INTAKE_INVALID_INPUT', '同一首歌新开的这一轮，提示词要一致', 400);
      if (!seen) groups.set(key, d);
    }
    const out = new Map(), author = intakeAuthor();
    for (const [key, d] of groups) {
      let songId = d.songId;
      if (!songId) songId = this.store.createSong(d.projectId, {requestId: derivedId(batchId, 'song', key), title: d.newSongTitle, notes: ''}, author).id;
      const roundId = derivedId(batchId, 'round', key);
      // 粘进来的往往是整段 Suno 提示词：拆成风格和歌词，只有风格会拆成音乐库标签（验收 PR5 P3-1）。
      const p = splitSunoPrompt(d.roundPrompt ?? '');
      this.store.createRound(d.projectId, songId, {requestId: roundId, prompt: {style: p.style, lyrics: p.lyrics, params: p.params}}, author, {fromIntake: true});
      out.set(key, {songId, roundId});
    }
    return {resolve: d => d.newRound ? out.get(this.groupKey(d)) : {songId: d.songId, roundId: d.roundId}};
  }

  // 预览（文件名预估、确认前预检）：不建任何东西。
  async previewTarget(value) {
    const d = this.destination(value);
    const {project, dir} = await this.folders.base(d.projectId);
    if (d.musicFolder === undefined) {
      if (d.songId) { const song = this.store.songRow(d.projectId, d.songId); if (song.data.status !== 'active') fail('SONG_NOT_ACTIVE', '这首歌不在进行中', 409); }
      if (d.roundId) { const r = this.store.roundRow(d.projectId, d.roundId); if (r.song_id !== d.songId) fail('INTAKE_INVALID_INPUT', '这一轮不属于所选的歌', 400); }
      return {directory: dir ?? path.join(this.store.files.configured, '.preview', project.id), verify: async () => {}};
    }
    if (!dir) return {directory: path.join(this.store.files.configured, '.preview', project.id), verify: async () => {}};
    const here = await this.folders.folderAt(dir, d.musicFolder);
    return {directory: here.abs, verify: async () => { await this.folders.folderAt(dir, d.musicFolder); }};
  }

  async prepare(value, plan = null) {
    const d = this.destination(value);
    const project = this.store.project(d.projectId);
    const base = await this.folders.base(d.projectId, {create: true});
    if (d.musicFolder === undefined) {
      const r = plan?.resolve(d) ?? {songId: d.songId, roundId: d.roundId};
      if (!r?.roundId) fail('INTAKE_INVALID_INPUT', '新开的一轮要在确认收纳时建好', 400);
      const song = this.store.songRow(d.projectId, r.songId), round = this.store.roundRow(d.projectId, r.roundId);
      if (round.song_id !== song.id) fail('INTAKE_INVALID_INPUT', '这一轮不属于所选的歌', 400);
      if (song.data.status !== 'active') fail('SONG_NOT_ACTIVE', song.data.status === 'final' ? '这首歌已定稿，撤回定稿后才能再收' : '这首歌已放弃，恢复为进行中后才能再收', 409);
      return {kind: 'project-music', mode: 'song', destination: d, projectId: project.id, songId: song.id, roundId: round.id, roundNo: round.round_no,
        label: `项目音乐 › 歌曲「${song.data.title}」 › 第 ${round.round_no} 轮${d.newRound ? '（新开）' : ''}`, target: base.dir};
    }
    const here = await this.folders.folderAt(base.dir, d.musicFolder);
    const st = await fs.lstat(here.abs);
    return {kind: 'project-music', mode: 'files', destination: d, projectId: project.id, folder: here.rel, target: here.abs, targetIdentity: {dev: String(st.dev), ino: String(st.ino)},
      label: `项目音乐 › 文件 › ${here.rel || '项目音乐文件夹'}`};
  }

  // 确认后到处理前，目标还在不在、是不是原来那个。
  async current(t) {
    this.store.project(t.projectId);
    if (t.mode === 'song') {
      const song = this.store.songRow(t.projectId, t.songId), round = this.store.roundRow(t.projectId, t.roundId);
      if (round.song_id !== song.id) fail('TARGET_CHANGED', '收纳目标的轮次已变化', 409);
      if (song.data.status !== 'active') fail('SONG_NOT_ACTIVE', '这首歌已经不在进行中，没有收进去；原文件保留', 409);
      return;
    }
    const st = await fs.lstat(t.target).catch(() => null);
    if (!st || !st.isDirectory() || st.isSymbolicLink() || String(st.dev) !== t.targetIdentity.dev || String(st.ino) !== t.targetIdentity.ino || await fs.realpath(t.target) !== t.target)
      fail('TARGET_CHANGED', '「文件」里的这个文件夹已改名、挪走或换掉了；原文件保留，请重新选择去处', 409);
  }

  // ---------- 选项（收纳窗口用） ----------

  async routing(projectId) {
    const view = await this.folders.base(projectId).then(async ({dir}) => dir ? (await this.folders.walk(dir)).folders : []).catch(() => []);
    const songs = this.store.list(projectId).songs.filter(s => s.status === 'active').map(s => {
      const last = s.rounds.at(-1);
      return {id: s.id, title: s.title, key: songKey(s.title),
        rounds: s.rounds.map(r => ({id: r.id, roundNo: r.roundNo, versionCount: r.versions.length, complete: r.complete})),
        // 最新一轮还没有版本（通常是 AI 开好、写好提示词，在等你去生成）就放进这一轮，否则默认新开一轮（SPEC 12.2）。
        defaultRound: last && !last.versions.length ? {roundId: last.id} : {newRound: true}};
    });
    return {folders: [{id: '', name: '项目音乐文件夹', relativePath: ''}, ...view.map(f => ({id: f.id, name: f.name, relativePath: f.id}))], songs};
  }

  // ---------- 处理时的适配器 ----------

  // 收纳端读：status、published（是否可能已经落盘）、instance、reused。
  // 落位前会把目标记进回执（placing）：没记过就一定没落盘，中断后判为失败、可以重试；记过的由重启收尾认领登记。
  rawReceipt(bound, s) {
    const interrupted = s.status === 'uploading' && s.instance !== this.store.instance;
    const placed = s.status === 'ready' || (s.status === 'uploading' && !!s.placing);
    return {...s, status: s.status === 'cancelled' || (interrupted && !s.placing) ? 'failed' : s.status, published: placed, reused: !!s.reused, interrupted};
  }

  receiptDTO(bound, s) {
    const song = bound.mode === 'song';
    let fileName = s.name ?? null, assetId = s.assetId ?? null;
    if (song && s.versionId) {
      const v = this.db.prepare('SELECT data_json FROM project_music_versions WHERE id=?').get(s.versionId);
      const d = v && JSON.parse(v.data_json);
      fileName = d?.fileName ?? null; assetId = d?.assetId ?? null;
    }
    const interrupted = s.status === 'uploading' && s.instance !== this.store.instance;
    const status = s.status === 'cancelled' || (interrupted && !s.placing) ? 'failed' : interrupted ? 'unknown' : s.status === 'uploading' ? 'waiting' : s.status;
    const base = `/api/project-music/projects/${bound.projectId}`;
    const candidates = s.status !== 'duplicate' ? [] : song
      ? (s.duplicates ?? []).map(d => ({id: d.versionId, name: `「${d.songTitle}」第 ${d.roundNo} 轮 ${d.label}${d.status === 'rejected' ? '（淘汰区）' : ''}`, reason: '项目里已经收过同样内容', adoptedShots: [], mediaUrl: `${base}/versions/${d.versionId}/media`}))
      : (s.duplicates ?? []).map(name => ({id: name, name, reason: '这个文件夹里已经有同样内容', adoptedShots: [], mediaUrl: `${base}/files/media?path=${encodeURIComponent([s.folder, name].filter(Boolean).join('/'))}`}));
    return {
      status, fileName, assetId, published: s.status === 'ready' || s.status === 'uploading', reused: !!s.reused, candidates,
      error: s.status === 'cancelled' ? '已取消本次操作' : interrupted && !s.placing ? '上次收纳在落盘前被中断，没有收进去；可以重试' : interrupted ? '上次收纳被中断，正在核对是否已落盘；没有自动重发' : s.status === 'duplicate' ? '已经收过了：可以「仍然保留」或「取消」' : s.error ?? null,
    };
  }

  async hash(file, expected) {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await handle.stat();
      if (expected && (String(st.dev) !== String(expected.dev) || String(st.ino) !== String(expected.ino) || st.size !== expected.size)) fail('SOURCE_CHANGED', '收纳结果文件已变化', 409);
      const h = createHash('sha256');
      for await (const chunk of handle.createReadStream({autoClose: false, start: 0})) h.update(chunk);
      return {hash: h.digest('hex')};
    } finally { await handle.close(); }
  }

  async source(assetId) {
    const file = this.store.assetFile(assetId);
    const a = this.db.prepare('SELECT sha256 FROM assets WHERE id=?').get(assetId);
    if (!/^[a-f0-9]{64}$/.test(a?.sha256 || '')) fail('SOURCE_UNVERIFIED', '收纳结果还没有内容摘要，原文件保留', 409);
    const opened = await this.store.files.openPath(file, {identity: null, sha256: a.sha256});
    await opened.handle.close();
    return {path: file, identity: opened.refreshed ?? stamp(await fs.lstat(file))};
  }

  bind(value, target) {
    const owner = this, store = this.store, folders = this.folders;
    if (canonical(this.destination(value)) !== canonical(target?.destination) || target?.kind !== 'project-music') fail('TARGET_CHANGED', '收纳目标与确认时不同', 409);
    const bound = structuredClone(target), song = bound.mode === 'song', pid = bound.projectId;
    const check = id => { if (id && id !== pid) fail('TARGET_CHANGED', '项目编号与固定目标不同', 409); };
    const same = state => { if (canonical(state) !== canonical(bound)) fail('TARGET_CHANGED', '不能替换已确认目标', 409); };
    const raw = requestId => store.importRow(pid, requestId, song ? 'song' : 'file');
    return {
      lib: store.lib, db: store.db, running: store.running, instance: store.instance,
      media: {
        track: fn => store.track(fn),
        async verify(source) {
          const st = await fs.lstat(source.path).catch(() => null);
          if (!st || String(st.dev) !== source.identity.dev || String(st.ino) !== source.identity.ino || st.size !== source.identity.size) fail('SOURCE_CHANGED', '收纳结果文件已变化，原文件保留', 409);
        },
      },
      project(id) { check(id); return store.project(pid); },
      async current(id, state = bound) { check(id); same(state); return owner.current(bound); },
      startIntake(id, input, state = bound) {
        check(id); same(state);
        if (song) store.startImport(pid, {requestId: input.requestId, roundId: bound.roundId, fileName: input.fileName, bytes: input.bytes}, intakeAuthor());
        else folders.startImport(pid, {requestId: input.requestId, folder: bound.folder, fileName: input.fileName, bytes: input.bytes}, intakeAuthor());
        return owner.receiptDTO(bound, raw(input.requestId));
      },
      async upload(id, requestId, stream) {
        check(id);
        await store.track(() => song ? store.upload(pid, requestId, stream) : folders.upload(pid, requestId, stream));
        return owner.receiptDTO(bound, raw(requestId));
      },
      receipt(id, requestId) { check(id); return owner.rawReceipt(bound, raw(requestId)); },
      receiptDTO(r) { return owner.receiptDTO(bound, r); },
      async resolve(id, requestId, input) {
        check(id);
        const choice = input?.choice;
        if (choice === 'reuse' || choice === 'overwrite') fail('INVALID_CHOICE', '项目音乐不提供复用或覆盖：可以「仍然保留」或「取消」', 400);
        if (!['import', 'rename', 'cancel'].includes(choice)) fail('INVALID_CHOICE', '请选择「仍然保留」或「取消」', 400);
        const s = raw(requestId);
        // 收纳端重试前要取消一份还在 waiting 的旧回执；项目音乐自己只允许 duplicate 时取消，这里补上。
        if (choice === 'cancel' && s.status === 'waiting' && !store.running.has(s.id)) {
          s.status = 'cancelled'; s.error = null; store.persistImport(s);
          return owner.receiptDTO(bound, s);
        }
        const mapped = {choice: choice === 'cancel' ? 'cancel' : 'keep'};
        await store.track(() => song ? store.resolveImport(pid, requestId, mapped) : folders.resolve(pid, requestId, mapped));
        return owner.receiptDTO(bound, raw(requestId));
      },
      async verifiedSource(id, assetId) { check(id); return owner.source(assetId); },
      assertIntakeBinding(id, requestId) {
        check(id);
        const s = raw(requestId);
        if (s.status !== 'ready') fail('TARGET_CHANGED', '收纳结果还没登记好，原文件保留', 409);
        const assetId = song ? JSON.parse(store.db.prepare('SELECT data_json FROM project_music_versions WHERE id=?').get(s.versionId)?.data_json ?? '{}').assetId : s.assetId;
        const a = assetId && store.db.prepare('SELECT trashed,root_id,path FROM assets WHERE id=?').get(assetId);
        const root = a && store.lib.roots().find(r => r.id === a.root_id);
        if (!a || a.trashed || !root || !within(root.path, a.path)) fail('TARGET_CHANGED', '收纳结果在音乐库里的记录已变化，原文件保留', 409);
      },
      hash(file, expected) { return owner.hash(file, expected); },
      // 项目音乐落位时已经把暂存文件挪走（硬链接后删除），没有别的临时副本要清。
      async cleanupIntakeStage() {},
    };
  }
}
