// 项目音乐：一首歌 › 多轮 › 每轮若干版本。只有定稿进音乐库（system_music/<分类>）并加入本项目候选。
import fs from 'node:fs/promises';
import path from 'node:path';
import {ensureMusicSchema} from './schema.mjs';
import {MusicFiles, roundFolder} from './files.mjs';
import * as M from './model.mjs';

const {fail} = M;
const parse = row => row && ({...row, revision: Number(row.revision ?? 0), round_no: row.round_no === undefined ? undefined : Number(row.round_no), data: JSON.parse(row.data_json)});
const PROMPT_FIELDS = ['tool', 'style', 'lyrics', 'params'];
const AGENT_FIELDS = ['expectedRevision', 'session', 'changes', 'issues', 'checks', 'nextDirection', 'listeningTranscripts', 'lyricTimes'];
const USER_ONLY = {
  prompt: '提示词由你粘贴或确认', sunoTier: 'Suno 会员档位由你填写', listening: '「你的听感」只能是你的原话；转录请用 listeningTranscripts',
  status: '版本取舍由你决定', bestVersionId: '当前最好由你决定', finalVersionId: '定稿由你决定',
  userIssues: '这是你自己写的问题整理；AI 请写 issues', userDirection: '这是你自己写的下一轮方向；AI 请写 nextDirection',
};

export class ProjectMusic {
  constructor({lib, projects, intake = null, dataDir, withActivity = fn => fn()}) {
    this.lib = lib;
    this.projects = projects;
    this.intake = intake;
    this.files = new MusicFiles(dataDir ?? lib.dataDir);
    this.withActivity = withActivity;
    this.queue = Promise.resolve();
    this.instance = M.newId();
    this.running = new Set();
    this.inflight = new Set();
    this.closing = false;
  }

  get db() { return this.lib.db; }

  init() { ensureMusicSchema(this.db); return this; }

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
    await Promise.allSettled([...this.inflight]);
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
    return {projectId, projectName: p.name, songs: songs.map(s => this.songDTO(s))};
  }

  song(projectId, songId) { return this.songDTO(this.songRow(projectId, songId)); }

  downloadName(song, round, version) {
    return `${song.data.title}-第${round.round_no}轮-${version.data.label}.${version.data.format}`;
  }

  versionDTO(song, round, v) {
    const d = v.data, base = `/api/project-music/projects/${v.project_id}/versions/${v.id}`;
    return {
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
    this.saveRow('project_music_rounds', round, d, input.expectedRevision);
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
    return this.song(projectId, v.song_id);
  }

  // ---------- 上传：登记 → 传内容 → 确认（同生成视频的三步） ----------

  importRow(projectId, requestId) {
    this.project(projectId);
    const id = M.requestId(requestId);
    const row = this.db.prepare('SELECT * FROM project_music_imports WHERE id=? AND project_id=?').get(id, projectId);
    if (!row) fail('IMPORT_NOT_FOUND', '没有找到这次上传记录', 404);
    return JSON.parse(row.data_json);
  }

  persistImport(s) {
    this.db.prepare('UPDATE project_music_imports SET data_json=?,updated_at=? WHERE id=?').run(M.canonical(s), M.now(), s.id);
  }

  importDTO(s) {
    const interrupted = s.status === 'uploading' && s.instance !== this.instance;
    return {
      id: s.id, projectId: s.projectId, songId: s.songId, roundId: s.roundId, status: interrupted ? 'failed' : s.status,
      fileName: s.fileName, bytes: s.bytes, label: s.label ?? null, versionId: s.versionId ?? null,
      duplicates: s.duplicates ?? [], error: interrupted ? '上次上传被中断，没有自动重发；请重新选择文件上传' : s.error ?? null,
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
        return this.publish(s);
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
    s.error = e.status ? e.message : ({ENOSPC: '磁盘空间不足', EACCES: '没有项目音乐目录的写入权限'}[e.code] || '上传失败') + '；没有生成新版本';
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
      if (input.choice !== 'keep') fail('INVALID_CHOICE', '请选择「仍然保存一份」或「取消」');
      this.running.add(s.id);
      try { return await this.publish(s); }
      catch (e) { await this.failImport(s, e); throw e; }
      finally { this.running.delete(s.id); }
    });
  }

  nextLetter(roundId) {
    const used = new Set(this.db.prepare('SELECT data_json FROM project_music_versions WHERE round_id=?').all(roundId).map(r => JSON.parse(r.data_json).label.toUpperCase()));
    for (let i = 0; i < 26; i++) { const l = String.fromCharCode(65 + i); if (!used.has(l)) return l; }
    let n = 27; while (used.has('V' + n)) n++; return 'V' + n;
  }

  async publish(s) {
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
    let songFolder = song.data.folder;
    if (!songFolder) {
      songFolder = await this.files.songFolder(project, song.id, song.data.title);
      this.saveInternal('project_music_songs', this.songRow(s.projectId, s.songId), {folder: songFolder});
    }
    const folder = `${songFolder}/${roundFolder(round.round_no)}`;
    const placed = await this.files.publish(s.stage, folder, label, s.ext);
    const at = M.now(), id = M.newId();
    const data = {
      label, originalName: s.fileName, fileName: placed.fileName, relativePath: placed.rel, format: M.FORMATS.get(s.ext),
      bytes: s.bytes, identity: placed.identity, durationMs: analysis.durationMs, peaks: analysis.peaks, loudnessDb: analysis.loudnessDb,
      status: 'candidate', note: '', rejectedAt: null, uploadedBy: s.uploadedBy, importRequestId: s.id,
    };
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO project_music_versions(id,project_id,song_id,round_id,sha256,data_json,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, s.projectId, s.songId, round.id, s.sha256, M.canonical(data), 1, at, at);
      s.status = 'ready'; s.versionId = id; s.label = label; s.error = null; delete s.stage;
      this.persistImport(s);
    })();
    return this.importDTO(s);
  }

  // ---------- 播放与下载 ----------

  async openVersion(projectId, versionId) {
    const v = this.versionRow(projectId, versionId);
    const opened = await this.files.open(v.data.relativePath, {identity: v.data.identity, sha256: v.sha256});
    if (opened.refreshed) {
      // 内容未变，只是时间戳变了：更新身份，不算新版本。
      const d = {...v.data, identity: opened.refreshed};
      this.db.prepare('UPDATE project_music_versions SET data_json=? WHERE id=?').run(M.canonical(d), v.id);
    }
    const song = this.songRow(projectId, v.song_id), round = this.roundRow(projectId, v.round_id);
    return {...opened, downloadName: this.downloadName(song, round, v)};
  }

  // ---------- 定稿：复制进音乐库 system_music/<分类>，并加入本项目候选 ----------

  // 上次进程里没结束的定稿：结果未知，显示为中断，允许重新定稿；不自动重做。
  interrupted(f) { return f?.status === 'running' && f.instance !== this.instance; }

  finalizationDTO(f) {
    if (!f) return null;
    const lost = this.interrupted(f);
    return {
      requestId: f.requestId, versionId: f.versionId, directory: f.directory, fileName: f.fileName, status: lost ? 'failed' : f.status,
      error: lost ? '上次定稿被中断，没有自动重做；可以重新定稿，音乐库里若已有同名文件会先让你选择' : f.error ?? null, assetId: f.assetId ?? null,
      candidates: (f.candidates ?? []).map(c => ({id: c.id, name: c.name, reason: c.reason, mediaUrl: c.mediaUrl})),
    };
  }

  requireIntake() {
    if (!this.intake) fail('INTAKE_UNAVAILABLE', '音乐库收纳暂不可用，无法定稿', 503);
    return this.intake;
  }

  async finalize(projectId, songId, input) {
    M.onlyKeys(input, ['requestId', 'expectedRevision', 'versionId', 'directory', 'fileName']);
    const requestId = M.requestId(input.requestId);
    return this.serial(async () => {
      const song = this.songRow(projectId, songId);
      const f = song.data.finalization;
      if (f?.requestId === requestId) return this.song(projectId, song.id);
      M.revision(input.expectedRevision);
      if (input.expectedRevision !== song.revision) this.conflict('project_music_songs', song.id);
      if (song.data.status !== 'active') fail('SONG_NOT_ACTIVE', song.data.status === 'final' ? '这首歌已经定稿' : '这首歌已放弃，先恢复为进行中', 409);
      if (f && ['running', 'duplicate'].includes(f.status) && !this.interrupted(f)) fail('FINALIZE_BUSY', '上一次定稿还没结束，请先处理', 409);
      const v = this.versionRow(projectId, input.versionId);
      if (v.song_id !== song.id) fail('VERSION_NOT_IN_SONG', '这个版本不属于这首歌', 409);
      if (v.data.status === 'rejected') fail('VERSION_REJECTED', '淘汰区的版本不能定稿，先恢复', 409);
      const directory = typeof input.directory === 'string' ? input.directory : '';
      const baseName = input.fileName ? M.text(input.fileName, '音乐库文件名', 200, {required: true}).trim() : song.data.title;
      const stem = M.FORMATS.has(path.extname(baseName).toLowerCase()) ? baseName.slice(0, -path.extname(baseName).length) : baseName;
      const fileName = `${stem.trim() || song.data.title}.${v.data.format}`;
      const intake = this.requireIntake();
      const data = structuredClone(song.data);
      data.finalization = {requestId, versionId: v.id, directory, fileName, status: 'running', target: null, instance: this.instance, at: M.now(), author: M.userAuthor()};
      this.saveRow('project_music_songs', song, data, input.expectedRevision);
      let fresh = this.songRow(projectId, song.id);
      try {
        const target = await intake.prepare({kind: 'music', scope: 'library', directory, fileName});
        fresh = this.songRow(projectId, song.id);
        this.saveRow('project_music_songs', fresh, {...fresh.data, finalization: {...fresh.data.finalization, target}});
        await intake.start(target, {requestId, fileName, bytes: v.data.bytes});
        const opened = await this.files.open(v.data.relativePath, {identity: v.data.identity, sha256: v.sha256});
        let dto;
        try { dto = await intake.upload(target, requestId, opened.handle.createReadStream({start: 0, autoClose: false})); }
        finally { await opened.handle.close(); }
        return this.applyIntake(projectId, song.id, dto);
      } catch (e) {
        this.markFinalizeFailed(projectId, song.id, e);
        throw e;
      }
    });
  }

  markFinalizeFailed(projectId, songId, e) {
    try {
      const row = this.songRow(projectId, songId);
      if (!row.data.finalization) return;
      this.saveRow('project_music_songs', row, {...row.data, finalization: {...row.data.finalization, status: 'failed', error: e.status ? e.message : '定稿复制失败；原版本保留，音乐库未登记'}});
    } catch { /* 回执保留为 running，页面会提示核对。 */ }
  }

  applyIntake(projectId, songId, dto) {
    const row = this.songRow(projectId, songId), d = structuredClone(row.data), f = d.finalization;
    if (dto.status === 'ready' && dto.assetId) {
      this.projects.add(projectId, {ids: [dto.assetId]});
      Object.assign(f, {status: 'ready', assetId: dto.assetId, error: null, candidates: []});
      d.status = 'final';
      d.finalVersionId = f.versionId;
      d.final = {assetId: dto.assetId, versionId: f.versionId, directory: f.directory, fileName: dto.fileName ?? f.fileName, requestId: f.requestId, at: M.now()};
    } else if (dto.status === 'duplicate') {
      Object.assign(f, {status: 'duplicate', candidates: dto.candidates ?? [], error: null});
    } else if (dto.status === 'cancelled') {
      Object.assign(f, {status: 'cancelled', candidates: [], error: null});
    } else {
      Object.assign(f, {status: 'failed', error: dto.error || '音乐库收纳没有完成'});
    }
    this.saveRow('project_music_songs', row, d);
    return this.song(projectId, songId);
  }

  async resolveFinalize(projectId, songId, requestId, input) {
    M.onlyKeys(input, ['choice', 'fileName', 'candidateId']);
    return this.serial(async () => {
      const song = this.songRow(projectId, songId), f = song.data.finalization;
      if (!f || f.requestId !== M.requestId(requestId)) fail('FINALIZE_NOT_FOUND', '没有找到这次定稿', 404);
      if (f.status !== 'duplicate') return this.song(projectId, song.id);
      if (!['rename', 'reuse', 'cancel'].includes(input.choice)) fail('INVALID_CHOICE', '请选择另存、沿用已有或取消');
      try {
        const dto = await this.requireIntake().resolve(f.target, f.requestId, input);
        return this.applyIntake(projectId, song.id, dto);
      } catch (e) {
        this.markFinalizeFailed(projectId, song.id, e);
        throw e;
      }
    });
  }

  // 撤回定稿：歌曲回到进行中。已进音乐库的文件和项目候选都不自动删（SPEC 第七节）。
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
}
