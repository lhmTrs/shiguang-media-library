// 项目音乐：一首歌 › 多轮 › 每轮若干版本。
// PR3（SPEC 第十一节）：全部版本都放进 personal_item/music（音乐库根目录「AI生成」）并登记进全库索引；
// 定稿只在项目里标记并加入本项目候选，不再复制进 system_music。同内容复用音乐库已有记录，不另存一份。
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ensureMusicSchema} from './schema.mjs';
import {MusicFiles, roundFolder, segment} from './files.mjs';
import {MetadataBatches} from '../metadata-batches.mjs';
import {directoryClass} from '../directory-classification.mjs';
import {within, indexFileIdentity} from '../fs-identity.mjs';
import * as M from './model.mjs';

const run = promisify(execFile);

const {fail} = M;
const parse = row => row && ({...row, revision: Number(row.revision ?? 0), round_no: row.round_no === undefined ? undefined : Number(row.round_no), data: JSON.parse(row.data_json)});
const PROMPT_FIELDS = ['tool', 'style', 'lyrics', 'params'];
const AGENT_FIELDS = ['expectedRevision', 'session', 'changes', 'issues', 'checks', 'nextDirection', 'listeningTranscripts', 'lyricTimes', 'measurements', 'decisions'];
const USER_ONLY = {
  prompt: '提示词由你粘贴或确认', sunoTier: 'Suno 会员档位由你填写', listening: '「你的听感」只能是你的原话；转录请用 listeningTranscripts',
  status: '改版本状态请用 decisions，并附上用户原话', bestVersionId: '改当前最好请用 decisions（action: best），并附上用户原话', finalVersionId: '定稿请用 decisions（action: final），并附上用户原话',
  userIssues: '这是你自己写的问题整理；AI 请写 issues', userDirection: '这是你自己写的下一轮方向；AI 请写 nextDirection',
};

export class ProjectMusic {
  constructor({lib, projects, dataDir, directory, metadata = null, trash = null, onRootAdded = () => {}, autoMigrate = true, withActivity = fn => fn()}) {
    this.lib = lib;
    this.projects = projects;
    if (!directory) throw Error('项目音乐需要 personal_item/music 目录');
    this.files = new MusicFiles(dataDir ?? lib.dataDir, directory);
    this.metadata = metadata;
    this.trashFile = trash;
    this.onRootAdded = onRootAdded;
    this.autoMigrate = autoMigrate;
    this.tagQueue = new Set();
    this.tagTimer = null;
    this.tagRunning = null;
    this.tagDelay = 0;
    this.migration = null;
    this.withActivity = withActivity;
    this.queue = Promise.resolve();
    this.instance = M.newId();
    this.running = new Set();
    this.inflight = new Set();
    this.closing = false;
  }

  get db() { return this.lib.db; }

  init() {
    ensureMusicSchema(this.db);
    // 上次没写完的音乐库标签：重新排队。旧位置的歌：后台搬迁（先复制、核对、登记，旧副本保留）。
    for (const r of this.db.prepare('SELECT id,data_json FROM project_music_versions').all()) {
      const d = JSON.parse(r.data_json);
      if (d.assetId && (d.tagSync?.pending ?? !d.syncedTags)) this.tagQueue.add(d.assetId);
    }
    if (this.tagQueue.size) this.kickTags(200);
    if (this.autoMigrate) {
      const timer = setTimeout(() => { this.migration = this.migrateAll().catch(e => console.warn('[project-music] 搬迁没有完成：', e.message)); }, 0);
      timer.unref?.();
      this.migrationTimer = timer;
    }
    return this;
  }

  serial(fn) {
    const work = this.queue.then(fn);
    this.queue = work.catch(() => {});
    return work;
  }

  track(fn) {
    if (this.closing) fail('MUSIC_CLOSING', '项目音乐正在关闭，请稍后再试', 503);
    const work = Promise.resolve().then(fn);
    this.inflight.add(work);
    work.finally(() => this.inflight.delete(work)).catch(() => {});
    return work;
  }

  async close() {
    this.closing = true;
    clearTimeout(this.migrationTimer);
    clearTimeout(this.tagTimer); this.tagTimer = null;
    await Promise.allSettled([...this.inflight, this.migration, this.tagRunning]);
  }

  // ---------- 读取 ----------

  project(id) {
    if (!M.idOK(id)) fail('INVALID_PROJECT', '项目编号无效');
    const p = this.db.prepare('SELECT id,name,project_kind FROM media_projects WHERE id=?').get(id);
    if (!p || (p.project_kind && p.project_kind !== 'normal')) fail('PROJECT_NOT_FOUND', '项目不存在或已删除', 404);
    return p;
  }

  songRow(projectId, songId) {
    this.project(projectId);
    if (!M.idOK(songId)) fail('SONG_NOT_FOUND', '歌曲编号无效', 404);
    const row = parse(this.db.prepare('SELECT * FROM project_music_songs WHERE id=? AND project_id=?').get(songId.toLowerCase(), projectId));
    if (!row) fail('SONG_NOT_FOUND', '没有找到这首歌', 404);
    return row;
  }

  roundRow(projectId, roundId) {
    this.project(projectId);
    if (!M.idOK(roundId)) fail('ROUND_NOT_FOUND', '轮次编号无效', 404);
    const row = parse(this.db.prepare('SELECT * FROM project_music_rounds WHERE id=? AND project_id=?').get(roundId.toLowerCase(), projectId));
    if (!row) fail('ROUND_NOT_FOUND', '没有找到这一轮', 404);
    return row;
  }

  versionRow(projectId, versionId) {
    this.project(projectId);
    if (!M.idOK(versionId)) fail('VERSION_NOT_FOUND', '版本编号无效', 404);
    const row = parse(this.db.prepare('SELECT * FROM project_music_versions WHERE id=? AND project_id=?').get(versionId.toLowerCase(), projectId));
    if (!row) fail('VERSION_NOT_FOUND', '没有找到这个版本', 404);
    return row;
  }

  rounds(songId) {
    return this.db.prepare('SELECT * FROM project_music_rounds WHERE song_id=? ORDER BY round_no').all(songId).map(parse);
  }

  versions(songId) {
    return this.db.prepare('SELECT * FROM project_music_versions WHERE song_id=? ORDER BY created_at,id').all(songId).map(parse);
  }

  comparisons(songId) {
    return this.db.prepare('SELECT * FROM project_music_comparisons WHERE song_id=? ORDER BY created_at,id').all(songId).map(parse);
  }

  list(projectId) {
    const p = this.project(projectId);
    const songs = this.db.prepare('SELECT * FROM project_music_songs WHERE project_id=? ORDER BY created_at DESC,id').all(projectId).map(parse);
    return {projectId, projectName: p.name, libraryRootName: M.LIBRARY_ROOT_NAME, songs: songs.map(s => this.songDTO(s)), legacy: this.legacySummary(projectId)};
  }

  // 旧位置（PR1、PR2）的搬迁情况：还没搬的、搬失败的、搬好了但旧副本还在的。
  legacySummary(projectId) {
    const rows = this.db.prepare('SELECT id,data_json FROM project_music_versions WHERE project_id=?').all(projectId).map(r => ({id: r.id, d: JSON.parse(r.data_json)}));
    const waiting = rows.filter(r => !r.d.assetId && !r.d.migration?.error).length;
    const failed = rows.filter(r => !r.d.assetId && r.d.migration?.error).map(r => ({versionId: r.id, error: r.d.migration.error}));
    const copies = rows.filter(r => r.d.legacy && !r.d.legacy.trashedAt).length;
    return {waiting, failed, copies, running: !!this.migrationActive};
  }

  song(projectId, songId) { return this.songDTO(this.songRow(projectId, songId)); }

  downloadName(song, round, version) {
    return `${song.data.title}-第${round.round_no}轮-${version.data.label}.${version.data.format}`;
  }

  // 音乐库里的情况：在不在、是不是复用的已有记录、位置有没有被挪过。
  libraryDTO(v) {
    const d = v.data;
    if (!d.assetId) return {inLibrary: false, assetId: null, migrating: !d.migration?.error, migrationError: d.migration?.error ?? null};
    const a = this.db.prepare('SELECT id,name,path,category,sub,trashed,online FROM assets WHERE id=?').get(d.assetId);
    const expected = d.relativePath && !d.reused ? this.files.expectedPath(d.relativePath) : null;
    return {
      inLibrary: !!a && !a.trashed, assetId: d.assetId, reused: !!d.reused, name: a?.name ?? null, category: a?.category ?? '', sub: a?.sub ?? '',
      missing: !a || !!a.trashed, offline: !!a && !a.online, moved: !!a && !!expected && a.path !== expected,
      tagSync: d.tagSync?.pending ? 'pending' : d.tagSync?.error ? 'failed' : d.syncedTags ? 'done' : 'pending', tagError: d.tagSync?.error ?? null,
    };
  }

  versionDTO(song, round, v) {
    const d = v.data, base = `/api/project-music/projects/${v.project_id}/versions/${v.id}`;
    const decision = (song.data.decisions ?? []).filter(x => x.versionId === v.id && !x.undone).at(-1);
    return {
      library: this.libraryDTO(v), tags: this.versionTags(song, round, v), measured: d.measured ?? null,
      decidedBy: decision ? {id: decision.id, action: decision.action, userWords: decision.userWords, saidAt: decision.saidAt, author: decision.author} : null,
      id: v.id, songId: v.song_id, roundId: v.round_id, roundNo: round.round_no, revision: v.revision,
      label: d.label, originalName: d.originalName, downloadName: this.downloadName(song, round, v),
      format: d.format, bytes: d.bytes, sha256: v.sha256, durationMs: d.durationMs, peaks: d.peaks, loudnessDb: d.loudnessDb,
      status: d.status, isBest: song.data.bestVersionId === v.id, isFinal: song.data.finalVersionId === v.id,
      note: d.note, uploadedBy: d.uploadedBy, rejectedAt: d.rejectedAt ?? null, createdAt: v.created_at,
      lyricTimes: round.data.lyricTimes?.[v.id] ?? null,
      mediaUrl: base + '/media', downloadUrl: base + '/media?download=1',
    };
  }

  comparisonDTO(c, versions, rounds) {
    const d = c.data, side = id => {
      const v = versions.find(x => x.id === id), r = v && rounds.find(x => x.id === v.round_id);
      return v ? {versionId: v.id, roundNo: r?.round_no ?? null, label: v.data.label} : {versionId: id, roundNo: null, label: '（版本不存在）'};
    };
    return {
      id: c.id, roundId: c.round_id, left: side(d.leftVersionId), right: side(d.rightVersionId), blind: d.blind,
      markers: d.markers, segments: d.segments, summary: d.summary, winner: d.winner, loudness: d.loudness, author: d.author, createdAt: c.created_at,
    };
  }

  roundDTO(song, round, versions, previous, comparisons = [], rounds = []) {
    const d = round.data, missing = M.roundMissing(d);
    const diff = previous ? PROMPT_FIELDS.filter(k => (previous.data.prompt?.[k] ?? '') !== (d.prompt?.[k] ?? '')) : [];
    return {
      id: round.id, songId: round.song_id, roundNo: round.round_no, revision: round.revision,
      prompt: d.prompt, promptConfirmed: d.promptConfirmed ?? null, promptDraftedBy: d.promptDraftedBy ?? null, sunoLinkBy: d.sunoLinkBy ?? null,
      changes: d.changes ?? null, listening: d.listening ?? [], issues: d.issues ?? null, checks: d.checks ?? null,
      nextDirection: d.nextDirection ?? null, userIssues: d.userIssues ?? null, userDirection: d.userDirection ?? null, comparisonNote: d.comparisonNote ?? null,
      promptDiffFromPrevious: previous ? diff : null, complete: missing.length === 0, missing,
      createdBy: d.createdBy, createdAt: round.created_at, updatedAt: round.updated_at,
      versions: versions.filter(v => v.round_id === round.id).map(v => this.versionDTO(song, round, v)),
      comparisons: comparisons.filter(c => c.round_id === round.id).map(c => this.comparisonDTO(c, versions, rounds)),
    };
  }

  songDTO(song) {
    const rounds = this.rounds(song.id), versions = this.versions(song.id), comparisons = this.comparisons(song.id), d = song.data;
    return {
      id: song.id, projectId: song.project_id, revision: song.revision, title: d.title, notes: d.notes, status: d.status,
      bestVersionId: d.bestVersionId ?? null, finalVersionId: d.finalVersionId ?? null,
      final: d.final ?? null, finalHistory: d.finalHistory ?? [], finalization: this.finalizationDTO(d.finalization),
      decisions: (d.decisions ?? []).slice(-30).map(x => ({...x, canUndo: !x.undone && this.decisionCurrent(song, x)})),
      createdBy: d.createdBy, createdAt: song.created_at, updatedAt: song.updated_at,
      rounds: rounds.map((r, i) => this.roundDTO(song, r, versions, rounds[i - 1], comparisons, rounds)),
    };
  }

  // ---------- 写入：歌曲 ----------

  saveRow(table, row, data, expected) {
    const next = row.revision + 1, at = M.now();
    const changed = this.db.prepare(`UPDATE ${table} SET data_json=?,revision=?,updated_at=? WHERE id=? AND revision=?`).run(M.canonical(data), next, at, row.id, expected ?? row.revision).changes;
    if (changed !== 1) this.conflict(table, row.id);
    return next;
  }

  // 内部字段（托管目录名）不算用户可见的修改，不增加版本号，避免打断页面上正在进行的编辑。
  saveInternal(table, row, patch) {
    const changed = this.db.prepare(`UPDATE ${table} SET data_json=? WHERE id=? AND revision=?`).run(M.canonical({...row.data, ...patch}), row.id, row.revision).changes;
    if (changed !== 1) this.conflict(table, row.id);
  }

  conflict(table, id) {
    const now = this.db.prepare(`SELECT revision FROM ${table} WHERE id=?`).get(id);
    fail('REVISION_CONFLICT', '内容已被别处更新，请刷新后再改；你的输入已保留', 409, {currentRevision: now ? Number(now.revision) : null});
  }

  createSong(projectId, input, author) {
    this.project(projectId);
    M.onlyKeys(input, ['requestId', 'title', 'notes', 'session']);
    const id = M.requestId(input.requestId), title = M.title(input.title), notes = M.text(input.notes ?? '', '备注', 4000);
    const args = M.digest({title, notes});
    const existing = parse(this.db.prepare('SELECT * FROM project_music_songs WHERE id=?').get(id));
    if (existing) {
      if (existing.project_id !== projectId || existing.data.args !== args) fail('REQUEST_ID_CONFLICT', '请求编号已用于其他内容', 409);
      return this.songDTO(existing);
    }
    const at = M.now(), data = {title, notes, status: 'active', bestVersionId: null, finalVersionId: null, final: null, finalHistory: [], finalization: null, folder: null, createdBy: author, args};
    this.db.prepare('INSERT INTO project_music_songs(id,project_id,data_json,revision,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, projectId, M.canonical(data), 1, at, at);
    return this.song(projectId, id);
  }

  updateSong(projectId, songId, input) {
    M.onlyKeys(input, ['expectedRevision', 'title', 'notes', 'status', 'bestVersionId']);
    const song = this.songRow(projectId, songId);
    M.revision(input.expectedRevision);
    if (input.expectedRevision !== song.revision) this.conflict('project_music_songs', song.id);
    const d = structuredClone(song.data);
    if (input.title !== undefined) d.title = M.title(input.title);
    if (input.notes !== undefined) d.notes = M.text(input.notes, '备注', 4000);
    if (input.status !== undefined) {
      if (!['active', 'abandoned'].includes(input.status)) fail('INVALID_INPUT', '歌曲状态只能改为进行中或放弃；定稿请用「定稿」');
      if (d.status === 'final') fail('SONG_FINAL', '这首歌已定稿，请先撤回定稿', 409);
      d.status = input.status;
    }
    if (input.bestVersionId !== undefined) {
      if (input.bestVersionId === null) d.bestVersionId = null;
      else {
        const v = this.versionRow(projectId, input.bestVersionId);
        if (v.song_id !== song.id) fail('VERSION_NOT_IN_SONG', '这个版本不属于这首歌', 409);
        if (v.data.status === 'rejected') fail('VERSION_REJECTED', '这个版本在淘汰区，先恢复再设为当前最好', 409);
        d.bestVersionId = v.id;
      }
    }
    this.saveRow('project_music_songs', song, d, input.expectedRevision);
    if (d.title !== song.data.title) this.queueSongTags(song.id);
    return this.song(projectId, song.id);
  }

  // ---------- 写入：轮次 ----------

  createRound(projectId, songId, input, author) {
    M.onlyKeys(input, ['requestId', 'prompt', 'session']);
    const song = this.songRow(projectId, songId);
    const id = M.requestId(input.requestId);
    const existing = parse(this.db.prepare('SELECT * FROM project_music_rounds WHERE id=?').get(id));
    const rounds = this.rounds(song.id), last = rounds.at(-1);
    const byUser = author.kind === 'user';
    // Suno 会员档位只能由用户填（SPEC 第十节）：AI 开新一轮时带档位一律拒绝；AI 开的轮次也不沿用上一轮的档位，
    // 留空等用户在自己的界面里填，「确认这份提示词」因此不会带出任何档位。
    if (!byUser && input.prompt && Object.hasOwn(input.prompt, 'sunoTier')) fail('AGENT_FIELD_FORBIDDEN', 'AI 不能填 Suno 会员档位：档位决定能不能商用，只能由你在页面上填', 403, {fields: ['prompt.sunoTier']});
    const prompt = M.prompt(input.prompt ?? {}, byUser ? last?.data.prompt : {...last?.data.prompt, sunoTier: ''});
    const args = M.digest({songId: song.id, prompt});
    if (existing) {
      if (existing.project_id !== projectId || existing.data.args !== args) fail('REQUEST_ID_CONFLICT', '请求编号已用于其他内容', 409);
      return this.song(projectId, song.id);
    }
    if (song.data.status !== 'active') fail('SONG_NOT_ACTIVE', song.data.status === 'final' ? '这首歌已定稿，撤回定稿后才能开新一轮' : '这首歌已放弃，恢复为进行中后才能开新一轮', 409);
    if (last) {
      const missing = M.roundMissing(last.data);
      if (missing.length) fail('PREVIOUS_ROUND_INCOMPLETE', `先补上一轮：第 ${last.round_no} 轮还缺「${missing.map(k => M.MISSING_LABEL[k]).join('」「')}」`, 409, {roundId: last.id, roundNo: last.round_no, missing});
    }
    const at = M.now();
    const data = {
      prompt, promptConfirmed: byUser ? author : null, promptDraftedBy: byUser ? null : author,
      sunoLinkBy: !byUser && prompt.sunoLink ? author : null,
      changes: null, listening: [], issues: null, checks: null, nextDirection: null, userIssues: null, userDirection: null, comparisonNote: null,
      createdBy: author, args,
    };
    const roundNo = (last?.round_no ?? 0) + 1;
    try {
      this.db.prepare('INSERT INTO project_music_rounds(id,project_id,song_id,round_no,data_json,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id, projectId, song.id, roundNo, M.canonical(data), 1, at, at);
    } catch (e) {
      if (/UNIQUE|Duplicate/i.test(String(e.message))) fail('REVISION_CONFLICT', '同时有另一轮刚被创建，请刷新后再试', 409);
      throw e;
    }
    return this.song(projectId, song.id);
  }

  // 页面（用户）改一轮：提示词、确认 AI 起草的提示词、你的听感原文；也可以自己写问题整理和下一轮方向（与 AI 写的分开存）。
  updateRound(projectId, roundId, input) {
    M.onlyKeys(input, ['expectedRevision', 'prompt', 'confirmPrompt', 'listening', 'userIssues', 'userDirection']);
    const round = this.roundRow(projectId, roundId);
    M.revision(input.expectedRevision);
    if (input.expectedRevision !== round.revision) this.conflict('project_music_rounds', round.id);
    const d = structuredClone(round.data), user = M.userAuthor();
    if (input.prompt !== undefined) {
      const next = M.prompt(input.prompt, d.prompt);
      // AI 填的 Suno 链接：你没改它就仍标「AI 填」；改了就算你填的。
      if (next.sunoLink !== d.prompt?.sunoLink) d.sunoLinkBy = null;
      d.prompt = next; d.promptConfirmed = user;
    }
    if (input.confirmPrompt === true) d.promptConfirmed = user;
    if (input.listening !== undefined) d.listening = this.mergeListening(d.listening ?? [], input.listening, user);
    if (input.userIssues !== undefined) { const t = M.userNote(input.userIssues, '你写的问题整理'); d.userIssues = t ? {text: t, author: user} : null; }
    if (input.userDirection !== undefined) { const t = M.userNote(input.userDirection, '你写的下一轮方向'); d.userDirection = t ? {text: t, author: user} : null; }
    this.saveRow('project_music_rounds', round, d, input.expectedRevision);
    if ((d.prompt?.style ?? '') !== (round.data.prompt?.style ?? '')) this.queueRoundTags(round.id);
    return this.song(projectId, round.song_id);
  }

  // 页面提交整组听感：原样未动的条目（含 AI 转录的出处）保留；改过或新增的记为你的原话。
  mergeListening(previous, list, user) {
    if (!Array.isArray(list) || list.length > 100) fail('INVALID_INPUT', '听感需要数组（最多 100 条）');
    const byId = new Map(previous.map(e => [e.id, e]));
    return list.map((entry, i) => {
      M.onlyKeys(entry, ['id', 'text'], 'INVALID_INPUT', `第 ${i + 1} 条听感含不支持的字段`);
      const body = M.text(entry.text, `第 ${i + 1} 条听感`, 4000, {required: true});
      const old = entry.id && byId.get(entry.id);
      if (old && old.text === body) return old;
      return {id: old ? old.id : M.newId(), text: body, kind: 'user', author: user};
    });
  }

  // AI 写一轮：只能写 AI 字段；听感只能追加逐字转录。越权字段整次拒绝，不部分写入。
  agentNotes(projectId, roundId, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', '请求体必须是 JSON 对象');
    const forbidden = Object.keys(input).filter(k => !AGENT_FIELDS.includes(k));
    if (forbidden.length) fail('AGENT_FIELD_FORBIDDEN', `AI 不能写这些字段：${forbidden.map(k => USER_ONLY[k] ? `${k}（${USER_ONLY[k]}）` : k).join('；')}`, 403, {fields: forbidden});
    const round = this.roundRow(projectId, roundId);
    const author = M.agentAuthor(input.session);
    M.revision(input.expectedRevision);
    if (input.expectedRevision !== round.revision) this.conflict('project_music_rounds', round.id);
    const d = structuredClone(round.data);
    if (input.changes !== undefined) d.changes = {...M.changes(input.changes), author};
    if (input.issues !== undefined) d.issues = {...M.issues(input.issues), author};
    if (input.checks !== undefined) d.checks = {...M.checks(input.checks), author};
    if (input.nextDirection !== undefined) d.nextDirection = {...M.nextDirection(input.nextDirection), author};
    if (input.listeningTranscripts !== undefined) {
      const t = input.listeningTranscripts;
      M.onlyKeys(t, ['verbatim', 'entries'], 'INVALID_INPUT', 'listeningTranscripts 只接受 verbatim 与 entries');
      if (t.verbatim !== true) fail('VERBATIM_REQUIRED', '转录听感必须是用户原话、一字不改，请带 verbatim:true', 400);
      if (!Array.isArray(t.entries) || !t.entries.length || t.entries.length > 20) fail('INVALID_INPUT', 'entries 需要 1–20 条');
      d.listening = [...(d.listening ?? []), ...t.entries.map((e, i) => {
        M.onlyKeys(e, ['text', 'saidAt'], 'INVALID_INPUT', `第 ${i + 1} 条转录含不支持的字段`);
        return {id: M.newId(), text: M.text(e.text, `第 ${i + 1} 条转录`, 4000, {required: true}), kind: 'transcript', saidAt: M.saidAt(e.saidAt), author};
      })];
    }
    if (input.lyricTimes !== undefined) {
      const inRound = new Set(this.db.prepare('SELECT id FROM project_music_versions WHERE round_id=?').all(round.id).map(r => r.id));
      const next = {...(d.lyricTimes ?? {})};
      for (const v of M.lyricTimes(input.lyricTimes)) {
        if (!inRound.has(v.versionId)) fail('VERSION_NOT_IN_ROUND', '歌词时间只能写给这一轮的版本', 409);
        next[v.versionId] = {lines: v.lines, method: v.method, author};
      }
      d.lyricTimes = next;
    }
    const measured = input.measurements !== undefined ? M.measurements(input.measurements) : [];
    const decided = input.decisions !== undefined ? M.decisions(input.decisions) : [];
    const touched = new Set();
    const finals = [];
    this.db.transaction(() => {
      this.saveRow('project_music_rounds', round, d, input.expectedRevision);
      for (const m of measured) {
        const v = this.versionRow(projectId, m.versionId);
        if (v.song_id !== round.song_id) fail('VERSION_NOT_IN_SONG', '测量结果只能写给这首歌的版本', 409);
        const {versionId: _, ...rest} = m;
        this.saveRow('project_music_versions', v, {...v.data, measured: {...rest, author}});
        if (v.data.assetId) touched.add(v.data.assetId);
      }
      for (const x of decided) {
        const r = this.decide(projectId, round.song_id, x, author);
        if (r.assetId) touched.add(r.assetId);
        if (r.final) finals.push(r.final);
      }
    })();
    for (const assetId of finals) this.projects.add(projectId, {ids: [assetId]});
    for (const id of touched) this.queueTags(id);
    return this.song(projectId, round.song_id);
  }

  // ---------- 对比结果（只限用户）：存进较新那个版本所在的轮次 ----------

  createComparison(projectId, songId, input) {
    const song = this.songRow(projectId, songId);
    const id = M.requestId(input?.requestId);
    const data = M.comparison(input);
    const existing = parse(this.db.prepare('SELECT * FROM project_music_comparisons WHERE id=?').get(id));
    const args = M.digest(data);
    if (existing) {
      if (existing.project_id !== projectId || existing.data.args !== args) fail('REQUEST_ID_CONFLICT', '请求编号已用于其他内容', 409);
      return this.song(projectId, song.id);
    }
    const [a, b] = [data.leftVersionId, data.rightVersionId].map(v => this.versionRow(projectId, v));
    if (a.song_id !== song.id || b.song_id !== song.id) fail('VERSION_NOT_IN_SONG', '只能对比同一首歌的版本', 409);
    const newer = a.created_at > b.created_at || (a.created_at === b.created_at && a.id > b.id) ? a : b;
    const at = M.now();
    this.db.prepare('INSERT INTO project_music_comparisons(id,project_id,song_id,round_id,data_json,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, projectId, song.id, newer.round_id, M.canonical({...data, author: M.userAuthor(), args}), 1, at, at);
    return this.song(projectId, song.id);
  }

  // ---------- 写入：版本取舍（只限用户） ----------

  updateVersion(projectId, versionId, input) {
    M.onlyKeys(input, ['expectedRevision', 'status', 'label', 'note', 'clearBest']);
    const v = this.versionRow(projectId, versionId);
    M.revision(input.expectedRevision);
    if (input.expectedRevision !== v.revision) this.conflict('project_music_versions', v.id);
    const song = this.songRow(projectId, v.song_id), d = structuredClone(v.data);
    let songData = null;
    if (input.label !== undefined) {
      const next = M.label(input.label);
      const taken = this.db.prepare('SELECT id,data_json FROM project_music_versions WHERE round_id=? AND id<>?').all(v.round_id, v.id).some(r => JSON.parse(r.data_json).label.toLowerCase() === next.toLowerCase());
      if (taken) fail('LABEL_TAKEN', '这一轮已有同名版本标签', 409);
      d.label = next;
    }
    if (input.note !== undefined) d.note = M.text(input.note, '版本备注', 2000);
    if (input.status !== undefined) {
      if (!['candidate', 'rejected'].includes(input.status)) fail('INVALID_INPUT', '版本状态只能是候选或淘汰');
      if (input.status === 'rejected' && d.status !== 'rejected') {
        if (song.data.finalVersionId === v.id && song.data.status === 'final') fail('VERSION_IS_FINAL', '这是定稿版本，先撤回定稿再淘汰', 409);
        if (song.data.bestVersionId === v.id) {
          if (input.clearBest !== true) fail('VERSION_IS_BEST', '这是当前最好；确认淘汰会让「当前最好」空出来', 409);
          songData = {...structuredClone(song.data), bestVersionId: null};
        }
        d.rejectedAt = M.now();
      }
      if (input.status === 'candidate') d.rejectedAt = null;
      d.status = input.status;
    }
    this.db.transaction(() => {
      this.saveRow('project_music_versions', v, d, input.expectedRevision);
      if (songData) this.saveRow('project_music_songs', song, songData);
    })();
    if (d.status !== v.data.status && d.assetId) this.queueTags(d.assetId);
    return this.song(projectId, v.song_id);
  }

  // ---------- 上传：登记 → 传内容 → 确认（同生成视频的三步） ----------

  // 回执表里同时放歌曲上传和「文件」区上传（kind: 'file'），按 kind 分开，不串用。
  importRow(projectId, requestId, kind = 'song') {
    this.project(projectId);
    const id = M.requestId(requestId);
    const row = this.db.prepare('SELECT * FROM project_music_imports WHERE id=? AND project_id=?').get(id, projectId);
    const s = row && JSON.parse(row.data_json);
    if (!s || (s.kind ?? 'song') !== kind) fail('IMPORT_NOT_FOUND', '没有找到这次上传记录', 404);
    return s;
  }

  persistImport(s) {
    this.db.prepare('UPDATE project_music_imports SET data_json=?,updated_at=? WHERE id=?').run(M.canonical(s), M.now(), s.id);
  }

  importDTO(s) {
    const interrupted = s.status === 'uploading' && s.instance !== this.instance;
    return {
      id: s.id, projectId: s.projectId, songId: s.songId, roundId: s.roundId, status: interrupted ? 'failed' : s.status,
      fileName: s.fileName, bytes: s.bytes, label: s.label ?? null, versionId: s.versionId ?? null,
      duplicates: s.duplicates ?? [], reused: s.reused ?? null,
      error: interrupted ? '上次上传被中断，没有自动重发；请重新选择文件上传' : s.error ?? null,
    };
  }

  startImport(projectId, input, author) {
    M.onlyKeys(input, ['requestId', 'roundId', 'fileName', 'bytes', 'label', 'session']);
    const id = M.requestId(input.requestId);
    const round = this.roundRow(projectId, input.roundId);
    const song = this.songRow(projectId, round.song_id);
    const {name, ext} = M.fileName(input.fileName);
    if (!Number.isSafeInteger(input.bytes) || input.bytes < 1) fail('INVALID_FILE', '文件长度无效');
    if (input.bytes > M.MAX_BYTES) fail('FILE_TOO_LARGE', '单个文件不能超过 200MB', 413);
    const label = input.label == null || input.label === '' ? null : M.label(input.label);
    const args = M.digest({roundId: round.id, name, bytes: input.bytes, label});
    const existing = this.db.prepare('SELECT * FROM project_music_imports WHERE id=?').get(id);
    if (existing) {
      const s = JSON.parse(existing.data_json);
      if (existing.project_id !== projectId || s.args !== args) fail('REQUEST_ID_CONFLICT', '请求编号已用于其他文件', 409);
      return this.importDTO(s);
    }
    if (song.data.status !== 'active') fail('SONG_NOT_ACTIVE', '这首歌不在进行中，不能再上传版本', 409);
    if (label && this.labelTaken(round.id, label)) fail('LABEL_TAKEN', '这一轮已有同名版本标签', 409);
    const at = M.now();
    const s = {id, projectId, songId: song.id, roundId: round.id, fileName: name, ext, bytes: input.bytes, label, args, status: 'waiting', instance: this.instance, uploadedBy: author, createdAt: at};
    this.db.prepare('INSERT INTO project_music_imports(id,project_id,data_json,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, projectId, M.canonical(s), at, at);
    return this.importDTO(s);
  }

  labelTaken(roundId, label) {
    return this.db.prepare('SELECT data_json FROM project_music_versions WHERE round_id=?').all(roundId).some(r => JSON.parse(r.data_json).label.toLowerCase() === label.toLowerCase());
  }

  receipt(projectId, requestId) { return this.importDTO(this.importRow(projectId, requestId)); }

  async upload(projectId, requestId, stream) {
    const s = this.importRow(projectId, requestId);
    if (s.status !== 'waiting' || this.running.has(s.id)) fail('IMPORT_BUSY', '这份文件已经接收过或正在接收；请查原回执，不要重复发送', 409);
    this.running.add(s.id);
    s.status = 'uploading'; s.instance = this.instance; this.persistImport(s);
    try {
      s.stage = await this.files.stagePath(s.id);
      const got = await this.files.receive(stream, s.stage, s.bytes, {check: () => { if (this.closing) fail('MUSIC_CLOSING', '项目音乐正在关闭', 503); }});
      s.sha256 = got.sha256; s.stageStat = got.stat;
      return await this.serial(async () => {
        // 同一项目里已有同内容的版本：先问你（SPEC 第四节「不悄悄复用」）。
        const dups = this.db.prepare('SELECT * FROM project_music_versions WHERE project_id=? AND sha256=?').all(projectId, s.sha256).map(parse);
        if (dups.length) {
          s.status = 'duplicate';
          s.duplicates = dups.map(v => {
            const song = this.db.prepare('SELECT data_json FROM project_music_songs WHERE id=?').get(v.song_id);
            const round = this.db.prepare('SELECT round_no FROM project_music_rounds WHERE id=?').get(v.round_id);
            return {versionId: v.id, songId: v.song_id, songTitle: song ? JSON.parse(song.data_json).title : '', roundNo: round ? Number(round.round_no) : null, label: v.data.label, status: v.data.status};
          });
          this.persistImport(s);
          return this.importDTO(s);
        }
        return this.place(s);
      });
    } catch (e) {
      await this.failImport(s, e);
      throw e;
    } finally {
      this.running.delete(s.id);
    }
  }

  async failImport(s, e) {
    s.status = 'failed';
    s.error = e.status ? e.message : ({ENOSPC: '磁盘空间不足', EACCES: '没有音乐目录的写入权限'}[e.code] || '上传失败') + '；没有生成新版本';
    if (s.stage) await fs.rm(s.stage, {force: true}).catch(() => {});
    try { this.persistImport(s); } catch { /* 原回执保留为 uploading，下次读取会显示为中断。 */ }
  }

  async resolveImport(projectId, requestId, input) {
    M.onlyKeys(input, ['choice']);
    return this.serial(async () => {
      const s = this.importRow(projectId, requestId);
      if (s.status === 'ready' || s.status === 'cancelled') return this.importDTO(s);
      if (s.status !== 'duplicate' || this.running.has(s.id)) fail('IMPORT_BUSY', '这次上传不在等待选择的状态', 409);
      if (input.choice === 'cancel') {
        await fs.rm(s.stage, {force: true}).catch(() => {});
        s.status = 'cancelled'; s.error = null; this.persistImport(s);
        return this.importDTO(s);
      }
      if (input.choice !== 'keep') fail('INVALID_CHOICE', '请选择「仍然保留」或「取消」');
      this.running.add(s.id);
      try { return await this.place(s); }
      catch (e) { await this.failImport(s, e); throw e; }
      finally { this.running.delete(s.id); }
    });
  }

  nextLetter(roundId) {
    const used = new Set(this.db.prepare('SELECT data_json FROM project_music_versions WHERE round_id=?').all(roundId).map(r => JSON.parse(r.data_json).label.toUpperCase()));
    for (let i = 0; i < 26; i++) { const l = String.fromCharCode(65 + i); if (!used.has(l)) return l; }
    let n = 27; while (used.has('V' + n)) n++; return 'V' + n;
  }

  fileStem(song, round, label) { return `${song.data.title}-${roundFolder(round.round_no)}-${label}`; }

  // 落位：音乐库里已有同内容的记录就复用（不另存一份，SPEC 11.6）；否则放进「歌曲/<歌名>/第NN轮」并登记进全库索引。
  async place(s) {
    const round = this.roundRow(s.projectId, s.roundId), song = this.songRow(s.projectId, s.songId);
    const st = await fs.lstat(s.stage).catch(() => null);
    if (!st || String(st.dev) !== s.stageStat.dev || String(st.ino) !== s.stageStat.ino || st.size !== s.bytes) fail('IMPORT_STAGE_CHANGED', '接收的临时文件已变化，请重新上传', 409);
    const isSuno = /suno/i.test(round.data.prompt?.tool ?? '');
    let label = s.label;
    if (!label && !isSuno) {
      try { label = M.label(path.basename(s.fileName, path.extname(s.fileName)).slice(0, 40).trim()); } catch { label = null; }
    }
    if (!label) label = this.nextLetter(round.id);
    if (this.labelTaken(round.id, label)) {
      if (s.label) fail('LABEL_TAKEN', '这一轮已有同名版本标签', 409);
      label = this.nextLetter(round.id);
    }
    const analysis = await this.files.analyze(s.stage);
    const project = this.project(s.projectId);
    const common = {
      label, originalName: s.fileName, format: M.FORMATS.get(s.ext), bytes: s.bytes,
      durationMs: analysis.durationMs, peaks: analysis.peaks, loudnessDb: analysis.loudnessDb,
      status: 'candidate', note: '', rejectedAt: null, uploadedBy: s.uploadedBy, importRequestId: s.id, storage: 'library',
    };
    const reuse = await this.reusableAsset(s.sha256, s.bytes);
    const at = M.now(), id = M.newId();
    let assetId, fresh = false;
    if (reuse) {
      assetId = reuse.asset.id;
      const data = {...common, fileName: path.basename(reuse.asset.path), relativePath: null, reused: true, identity: reuse.identity, assetId};
      this.db.transaction(() => {
        this.insertVersion(id, s, round, data, at);
        s.status = 'ready'; s.versionId = id; s.label = label; s.error = null; s.reused = {assetId, name: reuse.asset.name};
        this.persistImport(s);
      })();
      await fs.rm(s.stage, {force: true}).catch(() => {});
      delete s.stage; this.persistImport(s);
    } else {
      const root = await this.prepareRoot();
      const folder = `${await this.songLibraryFolder(s.projectId, s.songId, project)}/${roundFolder(round.round_no)}`;
      const placed = await this.files.publish(s.stage, folder, this.fileStem(song, round, label), s.ext);
      const file = await this.files.resolve(placed.rel), fst = await fs.lstat(file);
      try {
        this.db.transaction(() => {
          assetId = this.indexAsset(root, file, s.sha256, fst);
          this.insertVersion(id, s, round, {...common, fileName: placed.fileName, relativePath: placed.rel, reused: false, identity: placed.identity, assetId}, at);
          s.status = 'ready'; s.versionId = id; s.label = label; s.error = null; delete s.stage;
          this.persistImport(s);
        })();
        fresh = true;
      } catch (e) {
        await fs.rm(file, {force: true}).catch(() => {});
        throw e;
      }
    }
    if (fresh) this.lib.enqueue?.(assetId);
    this.queueTags(assetId);
    return this.importDTO(s);
  }

  insertVersion(id, s, round, data, at) {
    this.db.prepare('INSERT INTO project_music_versions(id,project_id,song_id,round_id,sha256,data_json,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, s.projectId, s.songId, round.id, s.sha256, M.canonical(data), 1, at, at);
  }

  // ---------- 音乐库：根目录「AI生成」、登记、复用 ----------

  // personal_item/music 登记成音乐库根目录，显示名「AI生成」（SPEC 11.2 开发时改）；第一次放歌时才登记。
  async prepareRoot() {
    const dir = await this.files.root();
    const roots = this.lib.allRoots();
    if (roots.some(r => r.retired && (within(r.path, dir) || within(dir, r.path)))) fail('MUSIC_ROOT_RETIRED', `「${M.LIBRARY_ROOT_NAME}」音乐目录已注销，请先在素材目录里恢复管理`, 409);
    let root = roots.find(r => !r.retired && within(r.path, dir));
    if (!root) {
      try { root = await this.lib.addRoot(dir, 'music'); }
      catch (e) { fail('MUSIC_ROOT_CONFLICT', `没能把音乐目录登记进音乐库：${e.message}`, 409); }
      this.lib.updateRoot(root.id, {name: M.LIBRARY_ROOT_NAME});
      root = this.lib.rootById(root.id);
      await this.onRootAdded();
    }
    return root;
  }

  indexAsset(root, file, sha256, st) {
    const old = this.db.prepare('SELECT * FROM assets WHERE path=?').get(file);
    if (old && (old.trashed || old.root_id !== root.id)) fail('MEDIA_CONFLICT', '音乐库里已有同一位置的记录且与项目音乐不符，文件保留', 409);
    const ids = indexFileIdentity(st);
    if (old) {
      this.db.prepare('UPDATE assets SET size=?,mtime=?,dev=?,ino=?,sha256=?,online=1 WHERE id=? AND path=? AND root_id=? AND trashed=0').run(st.size, st.mtimeMs, ids.dev, ids.ino, sha256, old.id, file, root.id);
      return old.id;
    }
    const id = M.newId(), cls = directoryClass(root, file) ?? {category: '', sub: '', review: 0};
    const kind = root.kind === 'music' ? 'music' : 'sfx';
    this.db.prepare('INSERT INTO assets(id,root_id,path,name,ext,kind,size,mtime,created_ms,category,sub,basis,review,dev,ino,sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, root.id, file, path.basename(file), path.extname(file).slice(1).toLowerCase(), kind, st.size, st.mtimeMs, Date.now(), cls.category, cls.sub, '项目音乐', cls.review, ids.dev, ids.ino, sha256);
    this.lib.directoryClassification?.sync?.(root.id, id);
    return id;
  }

  // 音乐库里同内容（SHA-256 一致、文件现在仍是那份内容）的在管记录。
  // 还没算过指纹的记录：同样大小的最多现场核对 8 条（只读，不替指纹模块写 sha256）。
  async reusableAsset(sha256, bytes = null) {
    const roots = new Map(this.lib.roots().map(r => [r.id, r]));
    const rows = this.db.prepare("SELECT id,root_id,path,name FROM assets WHERE sha256=? AND trashed=0 AND kind IN ('music','sfx') ORDER BY created_ms,id").all(sha256);
    if (Number.isSafeInteger(bytes)) rows.push(...this.db.prepare("SELECT id,root_id,path,name FROM assets WHERE size=? AND (sha256 IS NULL OR sha256='') AND trashed=0 AND kind IN ('music','sfx') ORDER BY created_ms,id LIMIT 8").all(bytes));
    for (const a of rows) {
      const root = roots.get(a.root_id);
      if (!root || !within(root.path, a.path)) continue;
      try {
        const o = await this.files.openPath(a.path, {identity: null, sha256});
        await o.handle.close();
        return {asset: a, identity: o.refreshed};
      } catch { /* 文件不在或内容变了：不复用这一条 */ }
    }
    return null;
  }

  // 歌曲文件夹：<项目>/歌曲/<歌名>；同一项目里重名时加「 (2)」。第一次放歌时定下，之后歌改名不改文件夹。
  async songLibraryFolder(projectId, songId, project) {
    let song = this.songRow(projectId, songId);
    if (song.data.libraryFolder) return this.files.ensureFolder(song.data.libraryFolder);
    const taken = new Set(this.db.prepare('SELECT data_json FROM project_music_songs WHERE project_id=? AND id<>?').all(projectId, songId)
      .map(r => JSON.parse(r.data_json).libraryFolder).filter(Boolean).map(f => path.posix.basename(f).normalize('NFC').toLowerCase()));
    const stem = segment(song.data.title, 110);
    let name = stem;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem} (${n})`;
    const rel = await this.files.songFolder(project, name);
    song = this.songRow(projectId, songId);
    this.saveInternal('project_music_songs', song, {libraryFolder: rel});
    return rel;
  }

  // ---------- 播放与下载 ----------

  assetFile(assetId) {
    const a = this.db.prepare('SELECT id,root_id,path,trashed FROM assets WHERE id=?').get(assetId);
    if (!a || a.trashed) fail('MUSIC_FILE_MISSING', '这个版本在音乐库里的记录已删除或移入废纸篓；项目里的记录保留', 404);
    const root = this.lib.roots().find(r => r.id === a.root_id);
    if (!root || !within(root.path, a.path)) fail('MUSIC_FILE_MISSING', '这个版本所在的音乐目录已注销', 404);
    return a.path;
  }

  async openVersion(projectId, versionId) {
    const v = this.versionRow(projectId, versionId);
    const expected = {identity: v.data.identity, sha256: v.sha256};
    const opened = v.data.assetId ? await this.files.openPath(this.assetFile(v.data.assetId), expected) : await this.files.openLegacy(v.data.relativePath, expected);
    if (opened.refreshed) {
      // 内容未变，只是时间戳变了：更新身份，不算新版本。
      const d = {...v.data, identity: opened.refreshed};
      this.db.prepare('UPDATE project_music_versions SET data_json=? WHERE id=?').run(M.canonical(d), v.id);
    }
    const song = this.songRow(projectId, v.song_id), round = this.roundRow(projectId, v.round_id);
    return {...opened, downloadName: this.downloadName(song, round, v)};
  }

  // ---------- 音乐库标签（SPEC 11.4） ----------

  projectName(projectId) {
    return this.db.prepare('SELECT name FROM media_projects WHERE id=?').get(projectId)?.name ?? '';
  }

  // 这个版本该有的标签和来源。只管这些标签：你在音乐库里自己加的标签不会被动。
  versionTags(song, round, v, projectName = this.projectName(v.project_id)) {
    const out = [];
    const add = (tag, source, extra = {}) => { const t = M.clipTag(tag); if (t && !out.some(x => x.tag.toLowerCase() === t.toLowerCase())) out.push({tag: t, source, ...extra}); };
    add(M.LIBRARY_ROOT_NAME, 'system');
    add(projectName, 'system');
    add(song.data.title, 'system');
    add(M.roundTag(round.round_no), 'system');
    for (const t of M.promptTags(round.data.prompt?.style)) add(t, 'prompt');
    for (const t of M.measuredTags(v.data.measured)) add(t, 'measured', {method: v.data.measured.method});
    if (v.data.status === 'rejected') add(M.unusedTag(projectName), 'status');
    return out;
  }

  assetVersions(assetId) {
    return this.db.prepare('SELECT * FROM project_music_versions WHERE data_json LIKE ?').all(`%"assetId":"${assetId}"%`).map(parse).filter(v => v.data.assetId === assetId);
  }

  batches() {
    if (!this.metadata) this.metadata = new MetadataBatches(this.lib).init();
    return this.metadata;
  }

  queueTags(assetId) {
    if (!assetId) return;
    this.tagQueue.add(assetId);
    this.markTags(assetId, {pending: true, error: null});
    this.kickTags(0);
  }
  queueRoundTags(roundId) { for (const r of this.db.prepare('SELECT data_json FROM project_music_versions WHERE round_id=?').all(roundId)) this.queueTags(JSON.parse(r.data_json).assetId); }
  queueSongTags(songId) { for (const r of this.db.prepare('SELECT data_json FROM project_music_versions WHERE song_id=?').all(songId)) this.queueTags(JSON.parse(r.data_json).assetId); }

  markTags(assetId, tagSync) {
    for (const v of this.assetVersions(assetId)) {
      try { this.saveInternal('project_music_versions', v, {tagSync: {...tagSync, at: M.now()}}); } catch { /* 下一次同步会再记 */ }
    }
  }

  kickTags(delay = 0) {
    if (this.tagTimer || this.closing) return;
    this.tagTimer = setTimeout(() => {
      this.tagTimer = null;
      if (this.tagRunning) return this.kickTags(50);
      this.tagRunning = this.flushTags().catch(e => console.warn('[project-music] 标签同步失败：', e.message)).finally(() => { this.tagRunning = null; });
    }, delay);
    this.tagTimer.unref?.();
  }

  async flushTags() {
    while (this.tagQueue.size && !this.closing) {
      const id = this.tagQueue.values().next().value;
      this.tagQueue.delete(id);
      try {
        await this.syncAssetTags(id);
        this.tagDelay = 0;
      } catch (e) {
        if (e.permanent) { this.markTags(id, {pending: false, error: e.message}); continue; }
        // 素材任务进行中等暂时原因：稍后重试，退避到最多 1 分钟。
        this.tagQueue.add(id);
        this.markTags(id, {pending: true, error: null, retry: e.message});
        this.tagDelay = Math.min(60000, this.tagDelay ? this.tagDelay * 2 : 1000);
        return this.kickTags(this.tagDelay);
      }
    }
  }

  // 只增删项目音乐自己写过的标签（syncedTags）。测量的按 basis=listened，其余按 basis=metadata，各写一个批次。
  async syncAssetTags(assetId) {
    const versions = this.assetVersions(assetId);
    if (!versions.length) return;
    const asset = this.db.prepare('SELECT id,trashed FROM assets WHERE id=?').get(assetId);
    if (!asset || asset.trashed) throw Object.assign(Error('音乐库里的记录已删除，没有写标签'), {permanent: true});
    const desired = [];
    for (const v of versions) {
      const song = parse(this.db.prepare('SELECT * FROM project_music_songs WHERE id=?').get(v.song_id));
      const round = parse(this.db.prepare('SELECT * FROM project_music_rounds WHERE id=?').get(v.round_id));
      if (!song || !round) continue;
      // 「未选用（项目）」：同一个项目里引用这份文件的版本全都淘汰了才打（同内容「仍然保留」会有两个版本共用一份）。
      const allRejected = versions.filter(x => x.project_id === v.project_id).every(x => x.data.status === 'rejected');
      for (const t of this.versionTags(song, round, v)) {
        if (t.source === 'status' && !allRejected) continue;
        if (!desired.some(d => d.tag === t.tag)) desired.push({tag: t.tag, basis: t.source === 'measured' ? 'listened' : 'metadata'});
      }
    }
    const synced = [...new Set(versions.flatMap(v => v.data.syncedTags ?? []))];
    const want = new Set(desired.map(d => d.tag));
    const first = versions.every(v => !v.data.syncedTags);
    const v0 = versions[0], s0 = parse(this.db.prepare('SELECT * FROM project_music_songs WHERE id=?').get(v0.song_id)), r0 = parse(this.db.prepare('SELECT * FROM project_music_rounds WHERE id=?').get(v0.round_id));
    const groups = [
      {basis: 'metadata', addTags: desired.filter(d => d.basis === 'metadata' && !synced.includes(d.tag)).map(d => d.tag), removeTags: synced.filter(t => !want.has(t)),
        note: first && s0 && r0 && !v0.data.reused ? {mode: 'ifEmpty', text: `项目音乐 · ${this.projectName(v0.project_id)} › ${s0.data.title} › 第${r0.round_no}轮 ${v0.data.label}`} : null,
        reason: '项目音乐：系统标签（AI生成、项目、歌名、轮次）、按提示词拆的标签、未选用'},
      {basis: 'listened', addTags: desired.filter(d => d.basis === 'listened' && !synced.includes(d.tag)).map(d => d.tag), removeTags: [],
        note: null, reason: '项目音乐：AI 测量的标签（方法记在项目音乐页的版本上）'},
    ];
    for (const g of groups) {
      if (!g.addTags.length && !g.removeTags.length && !g.note) continue;
      const changes = {addTags: g.addTags, removeTags: g.removeTags, ...(g.note ? {note: g.note} : {})};
      const {plan} = this.batches().preview({items: [{id: assetId, changes}], basis: g.basis, reason: g.reason});
      if (plan.skipped.length) throw Object.assign(Error(`没有写进音乐库：${plan.skipped[0].reason}`), {permanent: true});
      const done = await this.batches().apply(plan);
      if (done.skipped?.length) throw Error(done.skipped[0].reason);
    }
    for (const v of this.assetVersions(assetId)) this.saveInternal('project_music_versions', v, {syncedTags: [...want], tagSync: {pending: false, error: null, at: M.now()}});
  }

  // ---------- 定稿：只在项目里标记，并加入本项目候选（SPEC 11.5） ----------

  finalizationDTO(f) {
    if (!f) return null;
    const base = {requestId: f.requestId, versionId: f.versionId, directory: f.directory ?? '', fileName: f.fileName ?? '', assetId: f.assetId ?? null, candidates: []};
    // PR3 之后定稿只做标记、不再复制。旧流程没结束的定稿一律显示为「已停用」，可以重新定稿。
    if (f.status !== 'ready') return {...base, status: 'failed', error: '旧的定稿流程已停用：现在定稿只在项目里标记，不再复制进音乐库。请重新定稿。'};
    return {...base, status: 'ready', error: null};
  }

  finalPatch(song, v, requestId, author) {
    if (song.data.status !== 'active') fail('SONG_NOT_ACTIVE', song.data.status === 'final' ? '这首歌已经定稿' : '这首歌已放弃，先恢复为进行中', 409);
    if (v.song_id !== song.id) fail('VERSION_NOT_IN_SONG', '这个版本不属于这首歌', 409);
    if (v.data.status === 'rejected') fail('VERSION_REJECTED', '淘汰区的版本不能定稿，先恢复', 409);
    if (!v.data.assetId) fail('VERSION_NOT_IN_LIBRARY', '这个版本还在从旧位置搬进音乐库，搬好后再定稿', 409);
    return {status: 'final', finalVersionId: v.id, finalization: null, final: {assetId: v.data.assetId, versionId: v.id, requestId, at: M.now(), author}};
  }

  finalize(projectId, songId, input) {
    M.onlyKeys(input, ['requestId', 'expectedRevision', 'versionId']);
    const requestId = M.requestId(input.requestId);
    const song = this.songRow(projectId, songId);
    if (song.data.final?.requestId === requestId) return this.song(projectId, song.id);
    M.revision(input.expectedRevision);
    if (input.expectedRevision !== song.revision) this.conflict('project_music_songs', song.id);
    const v = this.versionRow(projectId, input.versionId);
    const patch = this.finalPatch(song, v, requestId, M.userAuthor());
    this.saveRow('project_music_songs', song, {...song.data, ...patch}, input.expectedRevision);
    this.projects.add(projectId, {ids: [patch.final.assetId]});
    return this.song(projectId, song.id);
  }

  // 撤回定稿：歌曲回到进行中。项目候选不自动删（SPEC 第七节）。
  unfinalize(projectId, songId, input) {
    M.onlyKeys(input, ['expectedRevision']);
    const song = this.songRow(projectId, songId);
    M.revision(input.expectedRevision);
    if (input.expectedRevision !== song.revision) this.conflict('project_music_songs', song.id);
    if (song.data.status !== 'final') fail('SONG_NOT_FINAL', '这首歌还没有定稿', 409);
    const d = structuredClone(song.data);
    d.finalHistory = [...(d.finalHistory ?? []), {...d.final, withdrawnAt: M.now()}];
    d.status = 'active'; d.finalVersionId = null; d.final = null; d.finalization = null;
    this.saveRow('project_music_songs', song, d, input.expectedRevision);
    return this.song(projectId, song.id);
  }

  // ---------- AI 按用户原话改版本状态；页面上能一键改回 ----------

  stateOf(song, v) {
    return {
      versionStatus: v.data.status, rejectedAt: v.data.rejectedAt ?? null, bestVersionId: song.data.bestVersionId ?? null,
      finalVersionId: song.data.finalVersionId ?? null, songStatus: song.data.status, finalAt: song.data.final?.at ?? null,
    };
  }

  decisionCurrent(song, x) {
    const v = parse(this.db.prepare('SELECT * FROM project_music_versions WHERE id=?').get(x.versionId));
    return !!v && M.canonical(this.stateOf(song, v)) === M.canonical(x.after);
  }

  // 在调用方的事务里执行一条：规则和页面上一样（定稿版不能淘汰、淘汰区不能设为当前最好等）。淘汰当前最好时，当前最好会空出来。
  decide(projectId, songId, x, author) {
    const song = this.songRow(projectId, songId), v = this.versionRow(projectId, x.versionId);
    if (v.song_id !== song.id) fail('VERSION_NOT_IN_SONG', '这个版本不属于这首歌', 409);
    const sd = structuredClone(song.data), vd = structuredClone(v.data);
    let final = null;
    if (x.action === 'reject') {
      if (sd.status === 'final' && sd.finalVersionId === v.id) fail('VERSION_IS_FINAL', '这是定稿版本，先撤回定稿再淘汰', 409);
      if (vd.status !== 'rejected') { vd.status = 'rejected'; vd.rejectedAt = M.now(); }
      if (sd.bestVersionId === v.id) sd.bestVersionId = null;
    } else if (x.action === 'restore') {
      vd.status = 'candidate'; vd.rejectedAt = null;
    } else if (x.action === 'best') {
      if (vd.status === 'rejected') fail('VERSION_REJECTED', '这个版本在淘汰区，先恢复再设为当前最好', 409);
      sd.bestVersionId = v.id;
    } else if (x.action === 'final') {
      Object.assign(sd, this.finalPatch(song, v, M.newId(), author));
      final = vd.assetId;
    }
    const before = this.stateOf(song, v), after = this.stateOf({data: sd}, {data: vd});
    if (M.canonical(before) === M.canonical(after)) return {assetId: null, final: null};
    sd.decisions = [...(sd.decisions ?? []), {id: M.newId(), action: x.action, versionId: v.id, userWords: x.userWords, saidAt: x.saidAt, author, at: M.now(), before, after, undone: null}].slice(-200);
    this.saveRow('project_music_versions', v, vd);
    this.saveRow('project_music_songs', song, sd);
    return {assetId: vd.assetId ?? null, final};
  }

  undoDecision(projectId, songId, decisionId, input) {
    M.onlyKeys(input, ['expectedRevision']);
    const song = this.songRow(projectId, songId);
    M.revision(input.expectedRevision);
    if (input.expectedRevision !== song.revision) this.conflict('project_music_songs', song.id);
    const x = (song.data.decisions ?? []).find(d => d.id === String(decisionId).toLowerCase());
    if (!x) fail('DECISION_NOT_FOUND', '没有找到这条 AI 改动', 404);
    if (x.undone) fail('DECISION_UNDONE', '这条已经改回过了', 409);
    if (!this.decisionCurrent(song, x)) fail('DECISION_CHANGED', '这条之后又改过，不能一键改回；请直接在页面上改', 409);
    const v = this.versionRow(projectId, x.versionId);
    const sd = structuredClone(song.data), vd = structuredClone(v.data), b = x.before;
    vd.status = b.versionStatus; vd.rejectedAt = b.rejectedAt;
    sd.bestVersionId = b.bestVersionId; sd.finalVersionId = b.finalVersionId;
    if (x.action === 'final') { sd.finalHistory = [...(sd.finalHistory ?? []), {...sd.final, withdrawnAt: M.now(), undoneDecision: x.id}]; sd.final = null; }
    sd.status = b.songStatus;
    sd.decisions = sd.decisions.map(d => d.id === x.id ? {...d, undone: {at: M.now(), author: M.userAuthor()}} : d);
    this.db.transaction(() => {
      this.saveRow('project_music_versions', v, vd);
      this.saveRow('project_music_songs', song, sd, input.expectedRevision);
    })();
    if (vd.assetId) this.queueTags(vd.assetId);
    return this.song(projectId, song.id);
  }

  // ---------- 搬迁：PR1、PR2 时期放在数据目录里的歌（SPEC 11.7） ----------
  // 先复制、核对 SHA-256、登记进音乐库，旧副本保留；用户在页面上确认后才移到废纸篓。

  async migrateAll() {
    if (this.closing || !(await this.files.legacyRoot())) return;
    const ids = this.db.prepare('SELECT id,data_json FROM project_music_versions ORDER BY created_at,id').all()
      .filter(r => { const d = JSON.parse(r.data_json); return !d.assetId && !d.migration?.error; }).map(r => r.id);
    if (!ids.length) return;
    this.migrationActive = true;
    let retry = false;
    try {
      for (const id of ids) {
        if (this.closing) return;
        try { await this.withActivity(() => this.track(() => this.serial(() => this.migrateVersion(id)))); }
        catch (e) { retry = true; console.warn('[project-music] 搬迁暂时没完成，稍后重试：', e.message); }
      }
    } finally {
      this.migrationActive = false;
    }
    if (retry && !this.closing) {
      this.migrationTimer = setTimeout(() => { this.migration = this.migrateAll().catch(() => {}); }, 30000);
      this.migrationTimer.unref?.();
    }
  }

  async migrateVersion(id) {
    let v = parse(this.db.prepare('SELECT * FROM project_music_versions WHERE id=?').get(id));
    if (!v || v.data.assetId) return;
    try {
      const project = this.project(v.project_id), song = this.songRow(v.project_id, v.song_id), round = this.roundRow(v.project_id, v.round_id);
      const opened = await this.files.openLegacy(v.data.relativePath, {identity: v.data.identity, sha256: v.sha256});
      let reuse = null, placed = null, file = null, root = null;
      try {
        reuse = await this.reusableAsset(v.sha256, v.data.bytes);
        if (!reuse) {
          const stage = await this.files.stagePath('migrate-' + v.id);
          const got = await this.files.receive(opened.handle.createReadStream({start: 0, autoClose: false}), stage, v.data.bytes);
          if (got.sha256 !== v.sha256) { await fs.rm(stage, {force: true}); fail('MUSIC_FILE_CHANGED', '从旧位置复制出来的内容和记录不一致，没有搬迁', 409); }
          root = await this.prepareRoot();
          const folder = `${await this.songLibraryFolder(v.project_id, v.song_id, project)}/${roundFolder(round.round_no)}`;
          placed = await this.files.publish(stage, folder, this.fileStem(song, round, v.data.label), path.extname(v.data.fileName || '') || '.' + v.data.format);
          file = await this.files.resolve(placed.rel);
        }
      } finally { await opened.handle.close(); }
      const fst = file ? await fs.lstat(file) : null;
      let assetId;
      try {
        this.db.transaction(() => {
          v = parse(this.db.prepare('SELECT * FROM project_music_versions WHERE id=?').get(id));
          assetId = reuse ? reuse.asset.id : this.indexAsset(root, file, v.sha256, fst);
          this.saveInternal('project_music_versions', v, {
            storage: 'library', assetId, reused: !!reuse, relativePath: reuse ? null : placed.rel,
            fileName: reuse ? path.basename(reuse.asset.path) : placed.fileName, identity: reuse ? reuse.identity : placed.identity,
            legacy: {relativePath: v.data.relativePath, identity: v.data.identity, trashedAt: null}, migration: {at: M.now(), error: null},
          });
        })();
      } catch (e) {
        if (file) await fs.rm(file, {force: true}).catch(() => {});
        throw e;
      }
      if (!reuse) this.lib.enqueue?.(assetId);
      this.queueTags(assetId);
    } catch (e) {
      if (!e.status) throw e;
      const fresh = parse(this.db.prepare('SELECT * FROM project_music_versions WHERE id=?').get(id));
      if (fresh && !fresh.data.assetId) this.saveInternal('project_music_versions', fresh, {migration: {at: M.now(), error: e.message}});
    }
  }

  // 页面上的「重试搬迁」：清掉这个项目里搬失败的记号，再搬一次。
  async retryMigration(projectId) {
    this.project(projectId);
    for (const r of this.db.prepare('SELECT * FROM project_music_versions WHERE project_id=?').all(projectId).map(parse)) {
      if (!r.data.assetId && r.data.migration?.error) this.saveInternal('project_music_versions', r, {migration: null});
    }
    if (!this.migrationActive) { this.migration = this.migrateAll().catch(() => {}); await this.migration; }
    return this.list(projectId);
  }

  async trash(file) {
    if (this.trashFile) return this.trashFile(file);
    if (!this.lib.trashBin) fail('TRASH_UNAVAILABLE', '系统废纸篓不可用，旧副本没有删除', 409);
    const {stdout} = await run(this.lib.trashBin, [file], {timeout: 30000});
    const target = JSON.parse(stdout);
    if (typeof target !== 'string' || !path.isAbsolute(target) || !/(^|\/)\.Trash(es)?\//.test(target)) fail('TRASH_UNSETTLED', '废纸篓结果尚未核清，请到废纸篓核对', 409);
    return target;
  }

  // 用户确认后：新位置能正常读出、旧副本内容也没变，才把旧副本移到废纸篓。逐个核对，不通过的保留并说明原因。
  async trashLegacy(projectId, input) {
    M.onlyKeys(input, ['confirm']);
    if (input.confirm !== true) fail('CONFIRM_REQUIRED', '请确认要把旧副本移到废纸篓', 400);
    this.project(projectId);
    return this.serial(async () => {
      const out = {trashed: 0, skipped: []};
      const rows = this.db.prepare('SELECT * FROM project_music_versions WHERE project_id=?').all(projectId).map(parse).filter(v => v.data.legacy && !v.data.legacy.trashedAt);
      const dirs = new Set();
      for (const v of rows) {
        try { const o = await this.openVersion(projectId, v.id); await o.handle.close(); }
        catch (e) { out.skipped.push({versionId: v.id, reason: `音乐库里的这一份核对没通过：${e.message}`}); continue; }
        let file = null;
        try { const o = await this.files.openLegacy(v.data.legacy.relativePath, {identity: v.data.legacy.identity, sha256: v.sha256}); file = o.path; await o.handle.close(); }
        catch (e) {
          if (e.code !== 'MUSIC_FILE_MISSING') { out.skipped.push({versionId: v.id, reason: `旧副本核对没通过：${e.message}`}); continue; }
        }
        let target = null;
        if (file) {
          try { target = await this.trash(file); }
          catch (e) { out.skipped.push({versionId: v.id, reason: e.message}); if (e.code === 'TRASH_UNAVAILABLE') break; continue; }
          dirs.add(path.dirname(file));
        }
        const fresh = parse(this.db.prepare('SELECT * FROM project_music_versions WHERE id=?').get(v.id));
        this.saveInternal('project_music_versions', fresh, {legacy: {...fresh.data.legacy, trashedAt: M.now(), trashPath: target, alreadyGone: !file}});
        out.trashed++;
      }
      // 只删空了的旧文件夹（轮次 → 歌 → 项目）；不空的不动。
      const base = await this.files.legacyRoot();
      for (const dir of dirs) {
        for (let d = dir; base && d !== base && within(base, d); d = path.dirname(d)) {
          try { await fs.rmdir(d); } catch { break; }
        }
      }
      return {...out, project: this.list(projectId)};
    });
  }
}
