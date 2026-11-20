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

// 音乐库标签是后台写的：等这首歌所有版本都写完（或写失败就直接报出来）。
async function tagsSettled(s, M, songId) {
  for (let i = 0; i < 400; i++) {
    const song = (await s.call('GET', M + `/songs/${songId}`)).body;
    const all = song.rounds.flatMap(r => r.versions);
    const failed = all.find(v => v.library.tagSync === 'failed');
    if (failed) assert.fail('音乐库标签写入失败：' + failed.library.tagError);
    if (all.every(v => !v.library.inLibrary || v.library.tagSync === 'done')) return song;
    await new Promise(r => setTimeout(r, 25));
  }
  assert.fail('音乐库标签一直没写完');
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

  // AI 开新一轮时不能填 Suno 会员档位：整次拒绝，不悄悄丢掉，也不建出这一轮
  for (const sunoTier of ['pro', 'unknown', '']) {
    const tier = await s.call('POST', M + `/songs/${song.id}/rounds`, {requestId: uuid(), session: '合成会话', prompt: {tool: 'Suno', style: '合成风格二', sunoTier}});
    assert.equal(tier.status, 403, sunoTier);
    assert.equal(tier.body.code, 'AGENT_FIELD_FORBIDDEN');
    assert.deepEqual(tier.body.details.fields, ['prompt.sunoTier']);
  }
  assert.equal((await s.call('GET', M + `/songs/${song.id}`)).body.rounds.length, 1, '被拒的请求没有建出新一轮');

  // 现在可以开第 2 轮；AI 开的轮次提示词待你确认，档位留空，Suno 链接标「AI 填」
  song = (await s.call('POST', M + `/songs/${song.id}/rounds`, {requestId: uuid(), session: '合成会话', prompt: {tool: 'Suno', style: '合成风格二 女声 慢板', lyrics: '第一句\n第二句', sunoLink: 'synthetic-suno-id'}})).body;
  const r2 = song.rounds[1];
  assert.equal(r2.roundNo, 2);
  assert.equal(r2.promptConfirmed, null);
  assert.equal(r2.promptDraftedBy.session, '合成会话');
  assert.deepEqual(r2.promptDiffFromPrevious, ['style']);
  assert.equal(r2.prompt.sunoTier, '', 'AI 开的轮次不沿用上一轮档位，留给你填');
  assert.equal(r2.sunoLinkBy.kind, 'agent');
  assert.equal(r2.sunoLinkBy.session, '合成会话');
  let confirmed = await s.call('PATCH', M + `/rounds/${r2.id}`, {expectedRevision: r2.revision, confirmPrompt: true}, {asPage: true});
  assert.equal(confirmed.body.rounds[1].promptConfirmed.kind, 'user');
  assert.equal(confirmed.body.rounds[1].prompt.sunoTier, '', '确认提示词不带出任何档位');
  assert.equal(confirmed.body.rounds[1].sunoLinkBy.kind, 'agent', '确认后链接仍标 AI 填');
  // 你在自己的界面里填档位；链接没改仍标 AI 填，改了就算你填的
  let r2now = confirmed.body.rounds[1];
  confirmed = await s.call('PATCH', M + `/rounds/${r2.id}`, {expectedRevision: r2now.revision, prompt: {...r2now.prompt, sunoTier: 'pro'}}, {asPage: true});
  r2now = confirmed.body.rounds[1];
  assert.equal(r2now.prompt.sunoTier, 'pro');
  assert.equal(r2now.sunoLinkBy.kind, 'agent');
  confirmed = await s.call('PATCH', M + `/rounds/${r2.id}`, {expectedRevision: r2now.revision, prompt: {...r2now.prompt, sunoLink: 'synthetic-suno-id-2'}}, {asPage: true});
  assert.equal(confirmed.body.rounds[1].sunoLinkBy, null);

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

  // PR3：全部版本放在 personal_item/music/<项目>/歌曲/<歌名>/第NN轮/，「仍然保留」的同内容版本复用同一条音乐库记录
  const musicDir = path.join(s.personal, 'music');
  const stored = (await walk(musicDir)).filter(f => !f.includes('.incoming'));
  assert.equal(stored.length, 4, '四种格式；重复内容复用已有记录，不另存一份；无残留临时文件：' + stored.join('\n'));
  const songDir = path.join(musicDir, `合成项目甲--${pid}`, '歌曲', '合成歌曲', '第01轮');
  assert.deepEqual(stored.map(f => path.relative(songDir, f)).sort(), ['合成歌曲-第01轮-A.mp3', '合成歌曲-第01轮-B.wav', '合成歌曲-第01轮-C.m4a', '合成歌曲-第01轮-D.flac']);
  assert.equal(await fs.stat(path.join(s.data, 'project-music')).then(() => true, () => false), false, '新歌不再写进数据目录');
  // 登记成音乐库根目录「AI生成」：主类是项目，子类是「歌曲」
  const roots = (await s.call('GET', '/roots')).body;
  const aiRoot = roots.find(r => r.name === 'AI生成');
  assert.ok(aiRoot, '音乐库里有「AI生成」：' + JSON.stringify(roots));
  assert.equal(aiRoot.kind, 'music');
  assert.equal((await s.call('PATCH', `/roots/${aiRoot.id}`, {name: '改名'})).body.code, 'MANAGED_ROOT_PROTECTED', '托管目录不能改名、注销');
  song = await tagsSettled(s, M, song.id);
  const vE = song.rounds[0].versions.find(v => v.label === 'E');
  const vA = song.rounds[0].versions.find(v => v.id === uploaded.mp3.id);
  assert.equal(vE.library.assetId, vA.library.assetId, '同内容「仍然保留」复用同一条音乐库记录');
  assert.equal(vE.library.reused, true);
  for (const v of song.rounds[0].versions) {
    assert.equal(v.library.inLibrary, true);
    assert.equal(v.library.category, `合成项目甲--${pid}`);
    assert.equal(v.library.sub, '歌曲');
    assert.equal(v.library.moved, false);
    assert.ok(!JSON.stringify(v.library).includes(s.personal), '不暴露本机路径');
  }
  const assetOf = async v => (await s.call('GET', `/assets/${v.library.assetId}`)).body;
  const aAsset = await assetOf(vA);
  assert.equal(aAsset.kind, 'music');
  assert.equal(aAsset.root_id, aiRoot.id);
  for (const tag of ['AI生成', '合成项目甲', '合成歌曲', '第1轮', '合成风格', '女声', '慢板']) assert.ok(aAsset.tags.includes(tag), `标签 ${tag}：${aAsset.tags}`);
  assert.match(aAsset.note, /^项目音乐 · 合成项目甲 › 合成歌曲 › 第1轮 A$/);
  assert.deepEqual(vA.tags.filter(t => t.source === 'prompt').map(t => t.tag), ['合成风格', '女声', '慢板'], '按提示词拆的标签');
  const history = (await s.call('GET', '/metadata/batches')).body;
  assert.ok(history.some(b => b.basis === 'metadata' && /项目音乐/.test(b.reason)), '沿用批量标注的 basis 写法，有记录可撤销');
  // 你在音乐库里自己加的标签不会被项目音乐动
  await s.call('PATCH', `/assets/${aAsset.id}`, {tags: [...aAsset.tags, '我自己的标签']});
  // 淘汰：音乐库里标「未选用（项目名）」，不隐藏；恢复后去掉。A 和 E 共用一份，所以用 C 来看。
  const C0 = song.rounds[0].versions.find(v => v.id === uploaded.m4a.id);
  song = (await s.call('PATCH', M + `/versions/${C0.id}`, {expectedRevision: C0.revision, status: 'rejected'}, {asPage: true})).body;
  song = await tagsSettled(s, M, song.id);
  const cRejected = song.rounds[0].versions.find(v => v.id === C0.id);
  assert.ok((await assetOf(cRejected)).tags.includes('未选用（合成项目甲）'));
  assert.equal((await assetOf(cRejected)).trashed, 0, '淘汰不删也不隐藏');
  song = (await s.call('PATCH', M + `/versions/${C0.id}`, {expectedRevision: cRejected.revision, status: 'candidate'}, {asPage: true})).body;
  song = await tagsSettled(s, M, song.id);
  assert.ok(!(await assetOf(cRejected)).tags.includes('未选用（合成项目甲）'));
  // A 被淘汰但 E（同一份文件）还在用：不打「未选用」
  {
    const a = song.rounds[0].versions.find(v => v.id === uploaded.mp3.id);
    song = (await s.call('PATCH', M + `/versions/${a.id}`, {expectedRevision: a.revision, status: 'rejected'}, {asPage: true})).body;
    song = await tagsSettled(s, M, song.id);
    const tags = (await assetOf(a)).tags;
    assert.ok(!tags.includes('未选用（合成项目甲）'), '共用文件的另一个版本还在用');
    assert.ok(tags.includes('我自己的标签'));
    const a2 = song.rounds[0].versions.find(v => v.id === a.id);
    song = (await s.call('PATCH', M + `/versions/${a.id}`, {expectedRevision: a2.revision, status: 'candidate'}, {asPage: true})).body;
  }

  // 文件被外部改动：拒绝播放和下载
  const cFile = stored.find(f => f.endsWith('C.m4a'));
  // 只改属性（ctime 变、内容不变）：重新核对内容后照常播放
  const dFile = stored.find(f => f.endsWith('D.flac'));
  await fs.chmod(dFile, 0o640);
  const attrOnly = await s.call('GET', M + `/versions/${uploaded.flac.id}/media`, undefined, {raw: true});
  assert.equal(attrOnly.status, 200, '只改属性不算改内容');
  assert.equal(sha(Buffer.from(await attrOnly.arrayBuffer())), sha(uploaded.flac.bytes));
  // 同长度改写内容，再把修改时间改回原值：播放和下载都必须拒绝
  const bFile = stored.find(f => f.endsWith('B.wav'));
  const before = await fs.stat(bFile);
  const handle = await fs.open(bFile, 'r+');
  const one = Buffer.alloc(1);
  await handle.read(one, 0, 1, before.size - 1);
  one[0] ^= 0xff;
  await handle.write(one, 0, 1, before.size - 1);
  await handle.close();
  await fs.utimes(bFile, before.atimeMs / 1000, before.mtimeMs / 1000);
  const sneaky = await fs.stat(bFile);
  assert.equal(sneaky.size, before.size);
  assert.equal(Math.round(sneaky.mtimeMs), Math.round(before.mtimeMs), '修改时间已改回原值（按身份核对的精度）');
  assert.notEqual(sneaky.ctimeMs, before.ctimeMs, 'ctime 无法改回');
  for (const q of ['', '?download=1']) {
    const res = await s.call('GET', M + `/versions/${uploaded.wav.id}/media${q}`);
    assert.equal(res.status, 409, '同长度改写并恢复修改时间后仍要拒绝' + q);
    assert.equal(res.body.code, 'MUSIC_FILE_CHANGED');
  }
  // 恢复原内容（再改回那一字节），后面的定稿用例继续用这一版
  const fix = await fs.open(bFile, 'r+');
  one[0] ^= 0xff;
  await fix.write(one, 0, 1, before.size - 1);
  await fix.close();
  await fs.appendFile(cFile, Buffer.from('tampered'));
  const changed = await s.call('GET', M + `/versions/${uploaded.m4a.id}/media`);
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, 'MUSIC_FILE_CHANGED');

  // 音乐库里已有同内容的文件（比如你先手动放进了自己的音乐目录）：直接复用那条记录，不另存一份
  {
    const own = path.join(base, '我的音乐', '配乐');
    await fs.mkdir(own, {recursive: true});
    const mine = await synth(own, '我先收好的.mp3', {freq: 660});
    const added = await s.call('POST', '/roots', {path: path.join(base, '我的音乐'), kind: 'music'});
    assert.equal(added.status, 200, added.text);
    for (let i = 0; i < 200 && (await s.call('GET', '/jobs')).body.some?.(j => j.status === 'running'); i++) await new Promise(r => setTimeout(r, 25));
    const mineAsset = (await s.call('GET', `/assets?root=${added.body.root.id}`)).body.items?.[0];
    assert.ok(mineAsset, '自己的音乐目录已扫描');
    const {put} = await upload(s, pid, r2.id, mine);
    assert.equal(put.body.status, 'ready', put.text);
    assert.equal(put.body.reused.assetId, mineAsset.id, '复用已有记录');
    assert.equal(put.body.reused.name, '我先收好的.mp3');
    assert.equal((await walk(musicDir)).filter(f => !f.includes('.incoming')).length, 4, '没有另存一份');
    song = await tagsSettled(s, M, song.id);
    const reusedV = song.rounds[1].versions[0];
    assert.equal(reusedV.library.reused, true);
    assert.equal(reusedV.library.category, '配乐');
    const got = await s.call('GET', M + `/versions/${reusedV.id}/media`, undefined, {raw: true});
    assert.equal(sha(Buffer.from(await got.arrayBuffer())), sha(await fs.readFile(mine)));
    const mineTags = (await s.call('GET', `/assets/${mineAsset.id}`)).body;
    assert.ok(mineTags.tags.includes('合成歌曲'), '复用的记录也补上项目音乐的标签');
    assert.equal(mineTags.note, '', '复用你自己的文件时不改它的备注');
  }

  // 定稿（PR3）：只在项目里标记并加入本项目候选，不再复制进 system_music
  const finReq = uuid();
  assert.equal((await s.call('POST', M + `/songs/${song.id}/finalize`, {requestId: finReq, expectedRevision: song.revision, versionId: B.id, directory: '合成分类'}, {asPage: true})).body.code, 'INVALID_INPUT', '不再选音乐库分类');
  const fin = await s.call('POST', M + `/songs/${song.id}/finalize`, {requestId: finReq, expectedRevision: song.revision, versionId: B.id}, {asPage: true});
  assert.equal(fin.status, 200, fin.text);
  song = fin.body;
  assert.equal(song.status, 'final');
  assert.equal(song.finalVersionId, B.id);
  assert.equal(song.finalization, null);
  const assetId = song.final.assetId;
  assert.equal(assetId, song.rounds[0].versions.find(v => v.id === B.id).library.assetId, '定稿就是音乐库里已有的那条记录');
  assert.equal(await fs.stat(path.join(s.personal, 'system_music')).then(() => true, () => false), false, '不再复制进 system_music');
  const items = await s.call('GET', `/projects/${pid}/items`);
  const linked = items.body.items.find(i => i.asset_id === assetId);
  assert.ok(linked, '加入了本项目素材：' + items.text.slice(0, 400));
  assert.equal(linked.status, 'candidate');
  assert.equal((await s.call('POST', M + `/songs/${song.id}/finalize`, {requestId: finReq, expectedRevision: 1, versionId: B.id}, {asPage: true})).body.final.assetId, assetId, '同一请求重放');
  assert.equal((await s.call('POST', M + `/songs/${song.id}/finalize/${finReq}/resolve`, {choice: 'rename'}, {asPage: true})).status, 410, '旧的重名选择步骤已停用');
  // 定稿后不能开新轮、不能再传
  assert.equal((await s.call('POST', M + `/songs/${song.id}/rounds`, {requestId: uuid(), prompt: {}}, {asPage: true})).body.code, 'SONG_NOT_ACTIVE');
  assert.equal((await s.call('POST', M + '/imports', {requestId: uuid(), roundId: r2.id, fileName: 'x.mp3', bytes: 10}, {asPage: true})).body.code, 'SONG_NOT_ACTIVE');
  assert.equal((await s.call('PATCH', M + `/versions/${B.id}`, {expectedRevision: B.revision, status: 'rejected'}, {asPage: true})).body.code, 'VERSION_IS_FINAL');

  // 撤回定稿：音乐库文件和项目候选都保留
  song = (await s.call('POST', M + `/songs/${song.id}/unfinalize`, {expectedRevision: song.revision}, {asPage: true})).body;
  assert.equal(song.status, 'active');
  assert.equal(song.finalHistory.length, 1);
  await fs.access(bFile);
  assert.ok((await s.call('GET', `/projects/${pid}/items`)).body.items.some(i => i.asset_id === assetId), '撤回定稿不移出项目候选');

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

test('项目音乐 · PR3：AI 测量标签、按用户原话改版本状态、页面一键改回', async t => {
  const base = await makeTemp(t);
  const audio = path.join(base, 'audio');
  await fs.mkdir(audio);
  const fa = await synth(audio, '甲.mp3', {freq: 300}), fb = await synth(audio, '乙.wav', {freq: 500});
  const s = await startServer(t, base);
  const pid = (await s.call('POST', '/projects', {name: '合成项目丙'})).body.id;
  const M = `/project-music/projects/${pid}`;
  let song = (await s.call('POST', M + '/songs', {requestId: uuid(), title: '合成歌'}, {asPage: true})).body;
  song = (await s.call('POST', M + `/songs/${song.id}/rounds`, {requestId: uuid(), prompt: {tool: 'Suno', style: '合成风格，电子／慢板'}}, {asPage: true})).body;
  const r1 = song.rounds[0];
  const A = (await upload(s, pid, r1.id, fa)).put.body.versionId, B = (await upload(s, pid, r1.id, fb)).put.body.versionId;
  song = await tagsSettled(s, M, song.id);
  let round = song.rounds[0];
  assert.deepEqual(round.versions[0].tags.filter(x => x.source === 'prompt').map(x => x.tag), ['合成风格', '电子', '慢板'], '逗号、全角斜杠都能拆');

  // 测量：AI 写结果和方法，标签由服务端按固定格式生成，basis=listened
  const measured = await s.call('PATCH', M + `/rounds/${round.id}/agent-notes`, {expectedRevision: round.revision, session: '合成会话',
    measurements: [{versionId: A, bpm: 120.4, durationMs: 2000, vocals: 'instrumental', language: '无歌词', method: '合成测量：ffprobe 读时长'}]});
  assert.equal(measured.status, 200, measured.text);
  song = await tagsSettled(s, M, song.id);
  const vA = song.rounds[0].versions.find(v => v.id === A);
  assert.deepEqual(vA.tags.filter(x => x.source === 'measured').map(x => [x.tag, x.method]), [['120 BPM', '合成测量：ffprobe 读时长'], ['时长 0:02', '合成测量：ffprobe 读时长'], ['纯音乐', '合成测量：ffprobe 读时长'], ['无歌词', '合成测量：ffprobe 读时长']]);
  const aTags = (await s.call('GET', `/assets/${vA.library.assetId}`)).body.tags;
  for (const tag of ['120 BPM', '时长 0:02', '纯音乐', '无歌词']) assert.ok(aTags.includes(tag), tag);
  assert.ok((await s.call('GET', '/metadata/batches')).body.some(b => b.basis === 'listened'), '测量标签按 listened 记');
  round = song.rounds[0];
  assert.equal((await s.call('PATCH', M + `/rounds/${round.id}/agent-notes`, {expectedRevision: round.revision, session: '合成会话', measurements: [{versionId: A, bpm: 120}]})).status, 400, '测量必须写方法');

  // 改状态必须附上用户原话；整次拒绝，不部分写入
  const noWords = await s.call('PATCH', M + `/rounds/${round.id}/agent-notes`, {expectedRevision: round.revision, session: '合成会话', changes: {text: 'x'}, decisions: [{versionId: A, action: 'best', userWords: ' '}]});
  assert.equal(noWords.status, 400);
  assert.equal(noWords.body.code, 'USER_WORDS_REQUIRED');
  assert.equal((await s.call('GET', M + `/songs/${song.id}`)).body.rounds[0].revision, round.revision);

  // 用户在对话里说了：设为当前最好
  const best = await s.call('PATCH', M + `/rounds/${round.id}/agent-notes`, {expectedRevision: round.revision, session: '合成会话', decisions: [{versionId: A, action: 'best', userWords: '甲这版最好', saidAt: '2026-11-20 20:01'}]});
  assert.equal(best.status, 200, best.text);
  song = best.body;
  assert.equal(song.bestVersionId, A);
  let vA2 = song.rounds[0].versions.find(v => v.id === A);
  assert.equal(vA2.decidedBy.userWords, '甲这版最好');
  assert.equal(vA2.decidedBy.author.kind, 'agent');
  assert.equal(vA2.decidedBy.author.session, '合成会话');
  assert.equal(song.decisions.at(-1).canUndo, true);
  // 再说「淘汰甲」：当前最好会空出来，音乐库里标「未选用」
  round = song.rounds[0];
  song = (await s.call('PATCH', M + `/rounds/${round.id}/agent-notes`, {expectedRevision: round.revision, session: '合成会话', decisions: [{versionId: A, action: 'reject', userWords: '甲还是不要了'}]})).body;
  assert.equal(song.bestVersionId, null);
  assert.equal(song.rounds[0].versions.find(v => v.id === A).status, 'rejected');
  song = await tagsSettled(s, M, song.id);
  assert.ok((await s.call('GET', `/assets/${vA.library.assetId}`)).body.tags.includes('未选用（合成项目丙）'));
  // 一键改回：只能在页面上做；改回后当前最好也回来
  const rejectDecision = song.decisions.at(-1);
  assert.equal((await s.call('POST', M + `/songs/${song.id}/decisions/${rejectDecision.id}/undo`, {expectedRevision: song.revision})).body.code, 'PAGE_ONLY');
  song = (await s.call('POST', M + `/songs/${song.id}/decisions/${rejectDecision.id}/undo`, {expectedRevision: song.revision}, {asPage: true})).body;
  assert.equal(song.bestVersionId, A);
  assert.equal(song.rounds[0].versions.find(v => v.id === A).status, 'candidate');
  assert.ok(song.decisions.find(d => d.id === rejectDecision.id).undone);
  assert.equal((await s.call('POST', M + `/songs/${song.id}/decisions/${rejectDecision.id}/undo`, {expectedRevision: song.revision}, {asPage: true})).body.code, 'DECISION_UNDONE');
  song = await tagsSettled(s, M, song.id);
  assert.ok(!(await s.call('GET', `/assets/${vA.library.assetId}`)).body.tags.includes('未选用（合成项目丙）'));

  // 定稿 B：加入本项目候选；之后你在页面上撤回了定稿，这条就不能一键改回
  round = song.rounds[0];
  song = (await s.call('PATCH', M + `/rounds/${round.id}/agent-notes`, {expectedRevision: round.revision, session: '合成会话', decisions: [{versionId: B, action: 'final', userWords: '就用乙定稿'}]})).body;
  assert.equal(song.status, 'final');
  assert.equal(song.finalVersionId, B);
  const bAsset = song.rounds[0].versions.find(v => v.id === B).library.assetId;
  assert.ok((await s.call('GET', `/projects/${pid}/items`)).body.items.some(i => i.asset_id === bAsset));
  const finalDecision = song.decisions.at(-1);
  song = (await s.call('POST', M + `/songs/${song.id}/unfinalize`, {expectedRevision: song.revision}, {asPage: true})).body;
  assert.equal(song.decisions.find(d => d.id === finalDecision.id).canUndo, false);
  const stale = await s.call('POST', M + `/songs/${song.id}/decisions/${finalDecision.id}/undo`, {expectedRevision: song.revision}, {asPage: true});
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'DECISION_CHANGED');
  // AI 仍然不能直接写状态字段
  round = song.rounds[0];
  assert.equal((await s.call('PATCH', M + `/rounds/${round.id}/agent-notes`, {expectedRevision: round.revision, session: '合成会话', status: 'rejected'})).body.code, 'AGENT_FIELD_FORBIDDEN');
});

test('项目音乐 · PR3 搬迁：旧位置的歌先复制、核对、登记，旧副本保留；确认后才移到废纸篓', async t => {
  const {Library} = await import('../server/library.mjs');
  const {MysqlStorage} = await import('../server/mysql.mjs');
  const {Projects} = await import('../server/projects.mjs');
  const {ProjectMusic} = await import('../server/project-music/store.mjs');
  const base = await fs.realpath(await makeTemp(t));
  const app = path.join(base, 'app'), personal = path.join(base, 'personal_item'), audio = path.join(base, 'audio');
  for (const d of [app, personal, audio]) await fs.mkdir(d, {recursive: true});
  const storage = await new MysqlStorage(app).init();
  const lib = await new Library(app, {directoryClassification: true}).init();
  storage.attach(lib);
  t.after(() => lib.db.close());
  const projects = new Projects(lib).init();
  const p = projects.save(null, {name: '合成项目乙'});
  const directory = path.join(personal, 'music');
  const page = {kind: 'user', at: 1};
  const first = new ProjectMusic({lib, projects, dataDir: app, directory, autoMigrate: false}).init();
  let song = first.createSong(p.id, {requestId: uuid(), title: '合成旧歌'}, page);
  song = first.createRound(p.id, song.id, {requestId: uuid(), prompt: {tool: 'Suno', style: '合成风格'}}, page);
  const round = song.rounds[0];
  await first.close();

  // 照 PR1 的格式造三条旧记录：一条正常、一条文件丢了、一条内容已在你自己的音乐目录里
  const legacyDir = path.join(app, 'project-music', `合成项目乙--${p.id}`, `合成旧歌--${song.id.slice(0, 8)}`, '第01轮');
  await fs.mkdir(legacyDir, {recursive: true});
  const a = await synth(legacyDir, 'A.mp3', {freq: 310});
  const c = await synth(legacyDir, 'C.mp3', {freq: 710});
  const own = path.join(base, '我的音乐', '配乐');
  await fs.mkdir(own, {recursive: true});
  await fs.copyFile(c, path.join(own, '同一首.mp3'));
  const ownRoot = await lib.addRoot(path.join(base, '我的音乐'), 'music');
  const job = lib.scan(ownRoot.id);
  while (job.status === 'running') await new Promise(r => setTimeout(r, 20));
  const ownAsset = lib.db.prepare('SELECT id FROM assets WHERE root_id=?').get(ownRoot.id);
  const stampOf = async f => { const st = await fs.lstat(f); return {dev: String(st.dev), ino: String(st.ino), size: st.size, mtimeMs: Math.round(st.mtimeMs), ctimeMs: Math.round(st.ctimeMs)}; };
  const legacy = async (label, file) => {
    const bytes = await fs.readFile(file).catch(() => Buffer.from('gone'));
    const id = uuid(), rel = `合成项目乙--${p.id}/合成旧歌--${song.id.slice(0, 8)}/第01轮/${label}.mp3`;
    const data = {label, originalName: label + '.mp3', fileName: label + '.mp3', relativePath: rel, format: 'mp3', bytes: bytes.length,
      identity: await stampOf(file).catch(() => ({dev: '1', ino: '1', size: 4, mtimeMs: 1, ctimeMs: 1})), durationMs: 2000, peaks: null, loudnessDb: null,
      status: 'candidate', note: '', rejectedAt: null, uploadedBy: page, importRequestId: uuid()};
    lib.db.prepare('INSERT INTO project_music_versions(id,project_id,song_id,round_id,sha256,data_json,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, p.id, song.id, round.id, sha(bytes), JSON.stringify(data), 1, Date.now(), Date.now());
    return id;
  };
  const idA = await legacy('A', a), idB = await legacy('B', path.join(legacyDir, 'B.mp3')), idC = await legacy('C', c);
  // 旧的定稿流程停在「重名待选择」：现在显示为已停用，可以重新定稿
  const row = lib.db.prepare('SELECT data_json,revision FROM project_music_songs WHERE id=?').get(song.id);
  lib.db.prepare('UPDATE project_music_songs SET data_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.data_json), finalization: {requestId: uuid(), versionId: idA, status: 'duplicate', candidates: []}}), song.id);

  const trashDir = path.join(base, '.Trash');
  await fs.mkdir(trashDir);
  const trashed = [];
  const store = new ProjectMusic({lib, projects, dataDir: app, directory, trash: async f => { const to = path.join(trashDir, path.basename(f)); await fs.rename(f, to); trashed.push(f); return to; }}).init();
  t.after(() => store.close());
  for (let i = 0; i < 400 && !store.migration; i++) await new Promise(r => setTimeout(r, 10));
  await store.migration;
  for (let i = 0; i < 400 && store.tagQueue.size + (store.tagRunning ? 1 : 0); i++) await new Promise(r => setTimeout(r, 10));

  let list = store.list(p.id);
  const vs = Object.fromEntries(list.songs[0].rounds[0].versions.map(v => [v.label, v]));
  assert.equal(vs.A.library.inLibrary, true);
  assert.equal(vs.A.library.reused, false);
  const newA = path.join(directory, `合成项目乙--${p.id}`, '歌曲', '合成旧歌', '第01轮', '合成旧歌-第01轮-A.mp3');
  assert.equal(sha(await fs.readFile(newA)), sha(await fs.readFile(a)), '复制后核对一致');
  await fs.access(a);
  assert.equal(vs.C.library.reused, true, '内容已在你的音乐目录里：复用那条记录');
  assert.equal(vs.C.library.assetId, ownAsset.id);
  assert.equal(vs.B.library.inLibrary, false);
  assert.match(vs.B.library.migrationError, /不见了/);
  assert.deepEqual({waiting: list.legacy.waiting, failed: list.legacy.failed.map(f => f.versionId), copies: list.legacy.copies}, {waiting: 0, failed: [idB], copies: 2});
  assert.equal(list.songs[0].finalization.status, 'failed');
  assert.match(list.songs[0].finalization.error, /旧的定稿流程已停用/);
  const opened = await store.openVersion(p.id, idA);
  assert.equal(opened.path, newA, '播放读的是音乐库里的新位置');
  await opened.handle.close();
  assert.ok(lib.asset(vs.A.library.assetId).tags.includes('合成旧歌'), '搬迁后补上标签');

  // 没确认不删；确认后旧副本移到废纸篓，空了的旧文件夹一并去掉
  await assert.rejects(() => store.trashLegacy(p.id, {}), e => e.code === 'CONFIRM_REQUIRED');
  const out = await store.trashLegacy(p.id, {confirm: true});
  assert.equal(out.trashed, 2, JSON.stringify(out.skipped));
  assert.deepEqual(trashed.map(f => path.basename(f)).sort(), ['A.mp3', 'C.mp3']);
  assert.equal(await fs.stat(path.join(app, 'project-music', `合成项目乙--${p.id}`)).then(() => true, () => false), false, '空的旧文件夹已去掉');
  assert.equal(out.project.legacy.copies, 0);
  await fs.access(newA);
  // 搬失败的那条：重试仍然失败，记录保留
  list = await store.retryMigration(p.id);
  assert.deepEqual(list.legacy.failed.map(f => f.versionId), [idB]);
  assert.equal(idC.length, 36);
});
