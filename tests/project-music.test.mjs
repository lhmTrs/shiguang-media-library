// 项目音乐（PR 1）：真实服务 + 全新临时 SQLite + 合成音频。覆盖 SPEC 第八节。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {tempDirectories} from './helpers/temp-cleanup.mjs';
import {startServer, synth} from './helpers/project-music-server.mjs';

const makeTemp = tempDirectories(test, 'sg-project-music-');
const uuid = () => crypto.randomUUID();
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, {withFileTypes: true})) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p)); else out.push(p);
  }
  return out;
}

async function upload(s, pid, roundId, file, extra = {}) {
  const bytes = await fs.readFile(file);
  const requestId = uuid();
  const start = await s.call('POST', `/project-music/projects/${pid}/imports`, {requestId, roundId, fileName: path.basename(file), bytes: bytes.length, ...extra}, {asPage: true});
  assert.equal(start.status, 200, start.text);
  assert.equal(start.body.status, 'waiting');
  const put = await s.call('PUT', `/project-music/projects/${pid}/imports/${requestId}/content`, bytes);
  return {requestId, put, bytes};
}

test('项目音乐：上传四种格式、重复内容、先补上一轮、AI 越权拒绝、版本保护、淘汰区、下载与身份核验、定稿进音乐库', async t => {
  const base = await makeTemp(t);
  const audio = path.join(base, 'audio');
  await fs.mkdir(audio);
  const files = {
    mp3: await synth(audio, '合成-甲.mp3', {freq: 330}),
    wav: await synth(audio, '合成-乙.wav', {freq: 440}),
    m4a: await synth(audio, '合成-丙.m4a', {freq: 550}),
    flac: await synth(audio, '合成-丁.flac', {noise: true}),
  };
  const s = await startServer(t, base);
  const created = await s.call('POST', '/projects', {name: '合成项目甲'});
  assert.equal(created.status, 200, created.text);
  const pid = created.body.id;
  const M = `/project-music/projects/${pid}`;

  // 空项目
  const empty = await s.call('GET', M);
  assert.equal(empty.status, 200, empty.text);
  assert.deepEqual(empty.body.songs, []);

  // 歌曲（同一请求编号重放得到同一首）
  const songReq = uuid();
  let song = (await s.call('POST', M + '/songs', {requestId: songReq, title: '合成歌曲'}, {asPage: true})).body;
  assert.equal(song.status, 'active');
  assert.equal(song.createdBy.kind, 'user');
  assert.equal((await s.call('POST', M + '/songs', {requestId: songReq, title: '合成歌曲'}, {asPage: true})).body.id, song.id);
  assert.equal((await s.call('POST', M + '/songs', {requestId: songReq, title: '别的歌'}, {asPage: true})).status, 409);
  // AI 建歌必须带会话名
  assert.equal((await s.call('POST', M + '/songs', {requestId: uuid(), title: '合成歌曲乙'})).status, 400);

  // 第 1 轮（页面创建 → 提示词已由你确认）
  song = (await s.call('POST', M + `/songs/${song.id}/rounds`, {requestId: uuid(), prompt: {tool: 'Suno', style: '合成风格 女声 慢板', lyrics: '第一句\n第二句', sunoTier: 'unknown'}}, {asPage: true})).body;
  const r1 = song.rounds[0];
  assert.equal(r1.roundNo, 1);
  assert.equal(r1.promptConfirmed.kind, 'user');
  assert.equal(r1.prompt.sunoTier, 'unknown');
  assert.deepEqual(r1.missing, ['issues', 'nextDirection']);

  // 上传四种格式；Suno 按 A/B/C/D 编号
  const uploaded = {};
  for (const [fmt, file] of Object.entries(files)) {
    const {put, bytes} = await upload(s, pid, r1.id, file);
    assert.equal(put.status, 200, put.text);
    assert.equal(put.body.status, 'ready', put.text);
    uploaded[fmt] = {id: put.body.versionId, label: put.body.label, bytes};
  }
  assert.deepEqual(Object.values(uploaded).map(v => v.label), ['A', 'B', 'C', 'D']);
  song = (await s.call('GET', M + `/songs/${song.id}`)).body;
  for (const v of song.rounds[0].versions) {
    assert.equal(v.peaks.length, 300, '真实波形峰值');
    assert.ok(v.durationMs > 1500 && v.durationMs < 2600, '时长约 2 秒：' + v.durationMs);
    assert.ok(Number.isFinite(v.loudnessDb));
    assert.match(v.downloadName, /^合成歌曲-第1轮-[ABCD]\.(mp3|wav|m4a|flac)$/);
    assert.ok(!JSON.stringify(v).includes(s.data), '版本信息不暴露本机路径');
  }
  assert.deepEqual(song.rounds[0].versions.map(v => v.format), ['mp3', 'wav', 'm4a', 'flac']);

  // 不支持的格式、超过 200MB、长度不符
  assert.equal((await s.call('POST', M + '/imports', {requestId: uuid(), roundId: r1.id, fileName: '合成.ogg', bytes: 10}, {asPage: true})).body.code, 'UNSUPPORTED_FORMAT');
  const big = await s.call('POST', M + '/imports', {requestId: uuid(), roundId: r1.id, fileName: '合成.wav', bytes: 200 * 1024 * 1024 + 1}, {asPage: true});
  assert.equal(big.status, 413);
  assert.equal(big.body.code, 'FILE_TOO_LARGE');
  {
    const bytes = await fs.readFile(files.wav), requestId = uuid();
    await s.call('POST', M + '/imports', {requestId, roundId: r1.id, fileName: 'short.wav', bytes: bytes.length + 5}, {asPage: true});
    const put = await s.call('PUT', M + `/imports/${requestId}/content`, bytes);
    assert.equal(put.status, 409);
    assert.equal(put.body.code, 'INVALID_LENGTH');
    assert.equal((await s.call('GET', M + `/imports/${requestId}`)).body.status, 'failed');
    assert.equal((await s.call('PUT', M + `/imports/${requestId}/content`, bytes)).body.code, 'IMPORT_BUSY', '失败的回执不能重发字节');
  }

  // 重复内容：提示，不悄悄复用
  {
    const first = await upload(s, pid, r1.id, files.mp3);
    assert.equal(first.put.body.status, 'duplicate');
    assert.equal(first.put.body.duplicates[0].label, 'A');
    assert.equal(first.put.body.duplicates[0].songTitle, '合成歌曲');
    const cancelled = await s.call('POST', M + `/imports/${first.requestId}/resolve`, {choice: 'cancel'});
    assert.equal(cancelled.body.status, 'cancelled');
    const second = await upload(s, pid, r1.id, files.mp3);
    assert.equal(second.put.body.status, 'duplicate');
    const kept = await s.call('POST', M + `/imports/${second.requestId}/resolve`, {choice: 'keep'});
    assert.equal(kept.body.status, 'ready', kept.text);
    assert.equal(kept.body.label, 'E');
  }

  // 先补上一轮：页面和 AI 开新一轮都会被拦
  for (const opts of [{asPage: true}, {}]) {
    const blocked = await s.call('POST', M + `/songs/${song.id}/rounds`, {requestId: uuid(), session: '合成会话', prompt: {style: '新风格'}}, opts);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'PREVIOUS_ROUND_INCOMPLETE');
    assert.deepEqual(blocked.body.details.missing, ['issues', 'nextDirection']);
    assert.match(blocked.body.error, /先补上一轮/);
  }

  // AI 写受限字段：整次拒绝
  let round = (await s.call('GET', M + `/songs/${song.id}`)).body.rounds[0];
  for (const field of [{listening: [{text: '伪造'}]}, {prompt: {style: 'x'}}, {status: 'rejected'}, {sunoTier: 'pro'}, {bestVersionId: uploaded.mp3.id}]) {
    const r = await s.call('PATCH', M + `/rounds/${round.id}/agent-notes`, {expectedRevision: round.revision, session: '合成会话', changes: {text: '只改风格'}, ...field});
    assert.equal(r.status, 403, JSON.stringify(field));
    assert.equal(r.body.code, 'AGENT_FIELD_FORBIDDEN');
  }
  assert.equal((await s.call('GET', M + `/songs/${song.id}`)).body.rounds[0].revision, round.revision, '被拒绝的请求没有部分写入');
  assert.equal((await s.call('PATCH', M + `/rounds/${round.id}/agent-notes`, {expectedRevision: round.revision, changes: {text: 'x'}})).status, 400, '必须带会话名');
  assert.equal((await s.call('PATCH', M + `/rounds/${round.id}/agent-notes`, {expectedRevision: round.revision, session: '合成会话', issues: {items: [{text: '副歌偏戏曲'}]}})).body.code, 'ISSUE_SOURCE_REQUIRED');
  assert.equal((await s.call('PATCH', M + `/rounds/${round.id}/agent-notes`, {expectedRevision: round.revision, session: '合成会话', checks: {items: [{item: 'tempo', result: '约 80 BPM'}]}})).status, 400, '客观检查必须写方法');

  // 只能由用户做的操作：没有浏览器同源标记一律拒绝
  assert.equal((await s.call('PATCH', M + `/versions/${uploaded.mp3.id}`, {expectedRevision: 1, status: 'rejected'})).body.code, 'PAGE_ONLY');
  assert.equal((await s.call('PATCH', M + `/rounds/${round.id}`, {expectedRevision: round.revision, listening: [{text: '伪造原话'}]})).body.code, 'PAGE_ONLY');
  assert.equal((await s.call('PATCH', M + `/songs/${song.id}`, {expectedRevision: song.revision, bestVersionId: uploaded.mp3.id})).body.code, 'PAGE_ONLY');
  assert.equal((await s.call('POST', M + `/songs/${song.id}/finalize`, {requestId: uuid(), expectedRevision: song.revision, versionId: uploaded.mp3.id, directory: ''})).body.code, 'PAGE_ONLY');

  // AI 正常写入 + 版本保护
  const notes = await s.call('PATCH', M + `/rounds/${round.id}/agent-notes`, {
    expectedRevision: round.revision, session: '合成会话',
    changes: {text: '第一轮，无上一轮可比', count: 0},
    issues: {items: [{text: '副歌唱腔偏戏曲', source: 'user_words', causeGuess: '可能和风格词有关'}, {text: '第二句含糊', source: 'objective_check'}]},
    checks: {items: [{item: 'duration', result: '各版约 2 秒', method: '读取版本 durationMs'}]},
    nextDirection: {text: '只改风格一处', promptDraft: {style: '合成风格二 女声 慢板', lyrics: '', params: ''}},
  });
  assert.equal(notes.status, 200, notes.text);
  round = notes.body.rounds[0];
  assert.equal(round.issues.author.kind, 'agent');
  assert.equal(round.issues.author.session, '合成会话');
  assert.ok(Number.isSafeInteger(round.issues.author.at));
  assert.equal(round.complete, true);
  const stale = await s.call('PATCH', M + `/rounds/${round.id}/agent-notes`, {expectedRevision: round.revision - 1, session: '合成会话', changes: {text: '旧版本上的改动'}});
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'REVISION_CONFLICT');
  assert.equal(stale.body.details.currentRevision, round.revision);

  // 听感转录：必须逐字声明；页面保存时原样保留转录出处，新写的记为你的原话
  assert.equal((await s.call('PATCH', M + `/rounds/${round.id}/agent-notes`, {expectedRevision: round.revision, session: '合成会话', listeningTranscripts: {entries: [{text: '合成原话'}]}})).body.code, 'VERBATIM_REQUIRED');
  round = (await s.call('PATCH', M + `/rounds/${round.id}/agent-notes`, {expectedRevision: round.revision, session: '合成会话', listeningTranscripts: {verbatim: true, entries: [{text: '副歌像戏腔，第二句听不清', saidAt: '2026-11-20 11:30'}]}})).body.rounds[0];
  const transcript = round.listening[0];
  assert.equal(transcript.kind, 'transcript');
  assert.equal(transcript.author.session, '合成会话');
  round = (await s.call('PATCH', M + `/rounds/${round.id}`, {expectedRevision: round.revision, listening: [{id: transcript.id, text: transcript.text}, {text: '前奏太长'}]}, {asPage: true})).body.rounds[0];
  assert.deepEqual(round.listening.map(e => e.kind), ['transcript', 'user']);
  assert.equal(round.listening[0].author.kind, 'agent');

  // 现在可以开第 2 轮；AI 开的轮次提示词待你确认
  song = (await s.call('POST', M + `/songs/${song.id}/rounds`, {requestId: uuid(), session: '合成会话', prompt: {tool: 'Suno', style: '合成风格二 女声 慢板', lyrics: '第一句\n第二句'}})).body;
  const r2 = song.rounds[1];
  assert.equal(r2.roundNo, 2);
  assert.equal(r2.promptConfirmed, null);
  assert.equal(r2.promptDraftedBy.session, '合成会话');
  assert.deepEqual(r2.promptDiffFromPrevious, ['style']);
  assert.equal(r2.prompt.sunoTier, 'unknown', '档位沿用上一轮');
  const confirmed = await s.call('PATCH', M + `/rounds/${r2.id}`, {expectedRevision: r2.revision, confirmPrompt: true}, {asPage: true});
  assert.equal(confirmed.body.rounds[1].promptConfirmed.kind, 'user');

  // 淘汰区：设为当前最好 → 淘汰需确认 → 恢复；淘汰不删文件
  song = (await s.call('PATCH', M + `/songs/${song.id}`, {expectedRevision: confirmed.body.revision, bestVersionId: uploaded.mp3.id}, {asPage: true})).body;
  assert.equal(song.bestVersionId, uploaded.mp3.id);
  const A = song.rounds[0].versions.find(v => v.id === uploaded.mp3.id);
  const needConfirm = await s.call('PATCH', M + `/versions/${A.id}`, {expectedRevision: A.revision, status: 'rejected'}, {asPage: true});
  assert.equal(needConfirm.body.code, 'VERSION_IS_BEST');
  song = (await s.call('PATCH', M + `/versions/${A.id}`, {expectedRevision: A.revision, status: 'rejected', clearBest: true}, {asPage: true})).body;
  assert.equal(song.bestVersionId, null);
  const rejected = song.rounds[0].versions.find(v => v.id === A.id);
  assert.equal(rejected.status, 'rejected');
  assert.ok(rejected.rejectedAt);
  assert.equal((await s.call('PATCH', M + `/songs/${song.id}`, {expectedRevision: song.revision, bestVersionId: A.id}, {asPage: true})).body.code, 'VERSION_REJECTED');
  const stillThere = await s.call('GET', M + `/versions/${A.id}/media`, undefined, {raw: true});
  assert.equal(stillThere.status, 200, '淘汰区的版本仍可试听');
  assert.equal(sha(Buffer.from(await stillThere.arrayBuffer())), sha(uploaded.mp3.bytes));
  song = (await s.call('PATCH', M + `/versions/${A.id}`, {expectedRevision: rejected.revision, status: 'candidate'}, {asPage: true})).body;
  assert.equal(song.rounds[0].versions.find(v => v.id === A.id).status, 'candidate');

  // 下载：Range 与规范文件名
  const B = song.rounds[0].versions.find(v => v.id === uploaded.wav.id);
  const part = await s.call('GET', M + `/versions/${B.id}/media`, undefined, {raw: true, headers: {range: 'bytes=0-99'}});
  assert.equal(part.status, 206);
  assert.equal((await part.arrayBuffer()).byteLength, 100);
  const whole = await s.call('GET', M + `/versions/${B.id}/media?download=1`, undefined, {raw: true});
  assert.match(whole.headers.get('content-disposition'), /filename\*=UTF-8''/);
  assert.ok(decodeURIComponent(whole.headers.get('content-disposition').split("UTF-8''")[1]) === '合成歌曲-第1轮-B.wav');
  assert.equal(sha(Buffer.from(await whole.arrayBuffer())), sha(uploaded.wav.bytes));

  // 文件被外部改动：拒绝播放和下载
  const stored = (await walk(path.join(s.data, 'project-music'))).filter(f => !f.includes('.incoming'));
  assert.equal(stored.length, 5, '四种格式 + 另存的重复一份，无残留临时文件：' + stored.join('\n'));
  const cFile = stored.find(f => f.endsWith(path.join('第01轮', 'C.m4a')));
  assert.ok(cFile, '按 项目/歌曲/轮次 放置');
  await fs.appendFile(cFile, Buffer.from('tampered'));
  const changed = await s.call('GET', M + `/versions/${uploaded.m4a.id}/media`);
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, 'MUSIC_FILE_CHANGED');

  // 定稿：复制进 system_music/<分类>，并加入本项目候选
  const category = await s.call('POST', '/file-intake/categories/music', {name: '合成分类'});
  assert.equal(category.status, 200, category.text);
  const finReq = uuid();
  const fin = await s.call('POST', M + `/songs/${song.id}/finalize`, {requestId: finReq, expectedRevision: song.revision, versionId: B.id, directory: '合成分类'}, {asPage: true});
  assert.equal(fin.status, 200, fin.text);
  song = fin.body;
  assert.equal(song.status, 'final');
  assert.equal(song.finalVersionId, B.id);
  assert.equal(song.finalization.status, 'ready');
  const assetId = song.final.assetId;
  const libraryFile = path.join(s.personal, 'system_music', '合成分类', '合成歌曲.wav');
  assert.equal(sha(await fs.readFile(libraryFile)), sha(uploaded.wav.bytes), '音乐库里是完整独立副本');
  assert.notEqual((await fs.stat(libraryFile)).ino, (await fs.stat(stored.find(f => f.endsWith('B.wav')))).ino);
  const items = await s.call('GET', `/projects/${pid}/items`);
  const linked = items.body.items.find(i => i.asset_id === assetId);
  assert.ok(linked, '加入了本项目素材：' + items.text.slice(0, 400));
  assert.equal(linked.status, 'candidate');
  // 同一请求重放不会复制第二份
  assert.equal((await s.call('POST', M + `/songs/${song.id}/finalize`, {requestId: finReq, expectedRevision: 1, versionId: B.id, directory: '合成分类'}, {asPage: true})).body.final.assetId, assetId);
  // 定稿后不能开新轮、不能再传
  assert.equal((await s.call('POST', M + `/songs/${song.id}/rounds`, {requestId: uuid(), prompt: {}}, {asPage: true})).body.code, 'SONG_NOT_ACTIVE');
  assert.equal((await s.call('POST', M + '/imports', {requestId: uuid(), roundId: r2.id, fileName: 'x.mp3', bytes: 10}, {asPage: true})).body.code, 'SONG_NOT_ACTIVE');
  assert.equal((await s.call('PATCH', M + `/versions/${B.id}`, {expectedRevision: B.revision, status: 'rejected'}, {asPage: true})).body.code, 'VERSION_IS_FINAL');

  // 撤回定稿：音乐库文件和项目候选都保留
  song = (await s.call('POST', M + `/songs/${song.id}/unfinalize`, {expectedRevision: song.revision}, {asPage: true})).body;
  assert.equal(song.status, 'active');
  assert.equal(song.finalHistory.length, 1);
  await fs.access(libraryFile);
  assert.ok((await s.call('GET', `/projects/${pid}/items`)).body.items.some(i => i.asset_id === assetId), '撤回定稿不移出项目候选');

  // 再次定稿到同名文件：先提示，选择另存后完成
  const again = await s.call('POST', M + `/songs/${song.id}/finalize`, {requestId: uuid(), expectedRevision: song.revision, versionId: uploaded.flac.id, directory: '合成分类', fileName: '合成歌曲.wav'}, {asPage: true});
  assert.equal(again.status, 200, again.text);
  // flac 版本：扩展名按版本格式改正，不与 wav 同名，直接完成
  assert.equal(again.body.finalization.status, 'ready', again.text);
  assert.equal(again.body.final.fileName, '合成歌曲.flac');
  song = (await s.call('POST', M + `/songs/${song.id}/unfinalize`, {expectedRevision: again.body.revision}, {asPage: true})).body;
  const dupReq = uuid();
  const dup = await s.call('POST', M + `/songs/${song.id}/finalize`, {requestId: dupReq, expectedRevision: song.revision, versionId: B.id, directory: '合成分类'}, {asPage: true});
  assert.equal(dup.body.finalization.status, 'duplicate', dup.text);
  assert.ok(dup.body.finalization.candidates.length >= 1);
  assert.ok(!JSON.stringify(dup.body).includes(s.personal), '定稿回执不暴露本机路径');
  const renamed = await s.call('POST', M + `/songs/${song.id}/finalize/${dupReq}/resolve`, {choice: 'rename', fileName: '合成歌曲 第二次.wav'}, {asPage: true});
  assert.equal(renamed.status, 200, renamed.text);
  assert.equal(renamed.body.status, 'final');
  // 另存沿用收纳模块的规则：从 _0 起加编号，最终文件名以回执为准
  assert.match(renamed.body.final.fileName, /^合成歌曲 第二次(_\d+)?\.wav$/);
  await fs.access(path.join(s.personal, 'system_music', '合成分类', renamed.body.final.fileName));

  // 项目使用说明：三行入口都能走通
  const guide = await s.call('GET', `/projects/${pid}/agent-guide`);
  assert.equal(guide.status, 200);
  for (const route of [`/api/project-music/projects/${pid}\``, `/api/project-music/projects/${pid}/versions/<versionId>/media?download=1`, `/api/project-music/projects/${pid}/rounds/<roundId>/agent-notes`]) assert.ok(guide.text.includes(route), route);
  assert.equal((await s.call('GET', '/project-music/schema')).status, 200);
});

test('项目音乐：并发同号轮次与中断回执', async t => {
  const base = await makeTemp(t);
  const s = await startServer(t, base);
  const pid = (await s.call('POST', '/projects', {name: '合成项目乙'})).body.id;
  const M = `/project-music/projects/${pid}`;
  const song = (await s.call('POST', M + '/songs', {requestId: uuid(), title: '合成歌曲丙'}, {asPage: true})).body;
  // 两个同时开第 1 轮：只有一个成功，另一个得到冲突提示，不会有两个第 1 轮
  const results = await Promise.all([0, 1].map(() => s.call('POST', M + `/songs/${song.id}/rounds`, {requestId: uuid(), prompt: {style: '合成'}}, {asPage: true})));
  const rounds = (await s.call('GET', M + `/songs/${song.id}`)).body.rounds;
  assert.ok(results.every(r => [200, 409].includes(r.status)), results.map(r => r.text).join('\n'));
  assert.equal(new Set(rounds.map(r => r.roundNo)).size, rounds.length, '轮次编号不重复');
  // 用户自己各写一句就算补上上一轮；AI 不能写用户的这两项；原话时间必须是北京时间格式
  let r1 = rounds[0];
  assert.equal((await s.call('POST', M + `/songs/${song.id}/rounds`, {requestId: uuid(), prompt: {}}, {asPage: true})).body.code, 'PREVIOUS_ROUND_INCOMPLETE');
  const agentUser = await s.call('PATCH', M + `/rounds/${r1.id}/agent-notes`, {expectedRevision: r1.revision, session: '合成会话', userIssues: '冒充用户'});
  assert.equal(agentUser.status, 403);
  assert.equal(agentUser.body.code, 'AGENT_FIELD_FORBIDDEN');
  assert.equal((await s.call('PATCH', M + `/rounds/${r1.id}/agent-notes`, {expectedRevision: r1.revision, session: '合成会话', listeningTranscripts: {verbatim: true, entries: [{text: '原话', saidAt: '11月20日上午'}]}})).status, 400);
  let after = await s.call('PATCH', M + `/rounds/${r1.id}`, {expectedRevision: r1.revision, userIssues: '副歌有点闷'}, {asPage: true});
  r1 = after.body.rounds[0];
  assert.equal(r1.userIssues.author.kind, 'user');
  assert.deepEqual(r1.missing, ['nextDirection']);
  after = await s.call('PATCH', M + `/rounds/${r1.id}`, {expectedRevision: r1.revision, userDirection: '下一轮只改速度'}, {asPage: true});
  assert.equal(after.body.rounds[0].complete, true);
  assert.equal(after.body.rounds[0].issues, null, '你写的和 AI 写的分开存放');
  const second = await s.call('POST', M + `/songs/${song.id}/rounds`, {requestId: uuid(), prompt: {style: '合成二'}}, {asPage: true});
  assert.equal(second.status, 200, second.text);
  assert.equal(second.body.rounds.length, rounds.length + 1);

  // 登记后未传内容的回执可以查询，状态仍是 waiting，不会自动重发
  const requestId = uuid();
  await s.call('POST', M + '/imports', {requestId, roundId: rounds[0].id, fileName: '合成.mp3', bytes: 1000}, {asPage: true});
  assert.equal((await s.call('GET', M + `/imports/${requestId}`)).body.status, 'waiting');
  assert.equal((await s.call('GET', M + `/imports/${uuid()}`)).status, 404);
});

test('项目音乐 · 对比：只由用户记录、存进较新版本所在的轮次；AI 歌词时间只写本轮版本', async t => {
  const base = await makeTemp(t);
  const audio = path.join(base, 'audio');
  await fs.mkdir(audio);
  const a = await synth(audio, '对比-甲.mp3', {freq: 330}), b = await synth(audio, '对比-乙.mp3', {freq: 440, volume: 0.5}), c = await synth(audio, '对比-丙.mp3', {freq: 550});
  const s = await startServer(t, base);
  const pid = (await s.call('POST', '/projects', {name: '合成对比项目'})).body.id;
  const M = `/project-music/projects/${pid}`;
  let song = (await s.call('POST', M + '/songs', {requestId: uuid(), title: '合成对比歌'}, {asPage: true})).body;
  song = (await s.call('POST', M + `/songs/${song.id}/rounds`, {requestId: uuid(), prompt: {tool: 'Suno', style: '合成'}}, {asPage: true})).body;
  const r1 = song.rounds[0];
  const vA = (await upload(s, pid, r1.id, a)).put.body.versionId, vB = (await upload(s, pid, r1.id, b)).put.body.versionId;
  song = (await s.call('PATCH', M + `/rounds/${r1.id}`, {expectedRevision: r1.revision, userIssues: '副歌闷', userDirection: '提速'}, {asPage: true})).body;
  song = (await s.call('POST', M + `/songs/${song.id}/rounds`, {requestId: uuid(), prompt: {style: '合成二'}}, {asPage: true})).body;
  const r2 = song.rounds[1];
  const vC = (await upload(s, pid, r2.id, c)).put.body.versionId;
  song = (await s.call('GET', M + `/songs/${song.id}`)).body;
  const [A, B] = song.rounds[0].versions;
  assert.ok(A.loudnessDb > B.loudnessDb + 3, '合成的乙版本更轻，响度估算应能看出来');

  // AI 的歌词时间
  let round1 = song.rounds[0];
  const lines = [{text: '第一句', startMs: 200}, {text: '第二句', startMs: 1100}];
  assert.equal((await s.call('PATCH', M + `/rounds/${round1.id}/agent-notes`, {expectedRevision: round1.revision, session: '合成会话', lyricTimes: [{versionId: vC, method: '人工听写', lines}]})).body.code, 'VERSION_NOT_IN_ROUND');
  assert.equal((await s.call('PATCH', M + `/rounds/${round1.id}/agent-notes`, {expectedRevision: round1.revision, session: '合成会话', lyricTimes: [{versionId: vA, method: '人工听写', lines: [{text: '一', startMs: 900}, {text: '二', startMs: 100}]}]})).status, 400);
  assert.equal((await s.call('PATCH', M + `/rounds/${round1.id}/agent-notes`, {expectedRevision: round1.revision, session: '合成会话', lyricTimes: [{versionId: vA, lines}]})).status, 400, '必须写得出方法');
  song = (await s.call('PATCH', M + `/rounds/${round1.id}/agent-notes`, {expectedRevision: round1.revision, session: '合成会话', lyricTimes: [{versionId: vA, method: '人工听写', lines}, {versionId: vB, method: '人工听写', lines: [{text: '第一句', startMs: 350}, {text: '第二句', startMs: 1300}]}]})).body;
  assert.equal(song.rounds[0].versions[0].lyricTimes.lines[1].startMs, 1100);
  assert.equal(song.rounds[0].versions[0].lyricTimes.author.session, '合成会话');

  // 对比结果：只由用户记录
  const C = M + `/songs/${song.id}/comparisons`;
  const body = {requestId: uuid(), leftVersionId: vA, rightVersionId: vC, blind: true, markers: [{label: '副歌', ms: 900}], segments: [{label: '副歌', winner: 'right'}], summary: '副歌 2 号好', winner: 'right', loudness: {matched: true, gainDb: 1.4}};
  assert.equal((await s.call('POST', C, body)).body.code, 'PAGE_ONLY', 'AI 不能代你记对比结果');
  assert.equal((await s.call('POST', C, {...body, requestId: uuid(), summary: '', segments: [], winner: null}, {asPage: true})).body.code, 'COMPARISON_EMPTY');
  assert.equal((await s.call('POST', C, {...body, requestId: uuid(), rightVersionId: vA}, {asPage: true})).status, 400);
  const other = (await s.call('POST', M + '/songs', {requestId: uuid(), title: '另一首合成歌'}, {asPage: true})).body;
  assert.equal((await s.call('POST', M + `/songs/${other.id}/comparisons`, {...body, requestId: uuid()}, {asPage: true})).body.code, 'VERSION_NOT_IN_SONG');
  const saved = await s.call('POST', C, body, {asPage: true});
  assert.equal(saved.status, 200, saved.text);
  const where = saved.body.rounds.find(r => r.comparisons.length);
  assert.equal(where.roundNo, 2, '存进较新版本所在的轮次');
  const cmp = where.comparisons[0];
  assert.deepEqual([cmp.left.label, cmp.left.roundNo, cmp.right.label, cmp.right.roundNo], ['A', 1, 'A', 2]);
  assert.equal(cmp.blind, true);
  assert.equal(cmp.author.kind, 'user');
  assert.deepEqual(cmp.markers, [{label: '副歌', ms: 900}]);
  // 同一请求重放不会多存一条；同号不同内容拒绝
  assert.equal((await s.call('POST', C, body, {asPage: true})).body.rounds.flatMap(r => r.comparisons).length, 1);
  assert.equal((await s.call('POST', C, {...body, summary: '改了'}, {asPage: true})).body.code, 'REQUEST_ID_CONFLICT');
  // 只写一句话也可以
  const short = await s.call('POST', C, {requestId: uuid(), leftVersionId: vA, rightVersionId: vB, summary: '差不多'}, {asPage: true});
  assert.equal(short.status, 200, short.text);
  assert.equal(short.body.rounds[0].comparisons[0].summary, '差不多');
  // AI 能读到对比结果
  assert.equal((await s.call('GET', M)).body.songs.find(x => x.id === song.id).rounds[1].comparisons[0].summary, '副歌 2 号好');
});
