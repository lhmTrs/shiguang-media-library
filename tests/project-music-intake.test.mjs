// 访达右键收纳 → 项目音乐（PR5，SPEC 第十二节和第十三节的扩展）：真实收纳模块 + 全新临时库 + 合成音频。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID, createHash} from 'node:crypto';
import {Library} from '../server/library.mjs';
import {Projects} from '../server/projects.mjs';
import {ProjectAssets} from '../server/project-assets/store.mjs';
import {VideoMedia} from '../server/storyboard-video/media.mjs';
import {ManagedIntakeCatalog} from '../server/file-intake/media-catalog.mjs';
import {FileIntake} from '../server/file-intake/store.mjs';
import {IntakePreferences} from '../server/file-intake/preferences.mjs';
import {ProjectMusic} from '../server/project-music/store.mjs';
import {MusicFolders} from '../server/project-music/folders.mjs';
import {ProjectMusicIntake, songKey} from '../server/project-music/intake.mjs';
import {synth} from './helpers/project-music-server.mjs';
import {openIntakeFixture, intakeSettled, recovered} from './helpers/project-music-intake-fixture.mjs';
import {spawn} from 'node:child_process';
import {once} from 'node:events';

const sha = buf => createHash('sha256').update(buf).digest('hex');

async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sg-project-music-intake-'))), dataDir = path.join(dir, 'data');
  const lib = await new Library(dataDir, {directoryClassification: true}).init(); lib.enqueue = () => {};
  const projects = new Projects(lib).init(), assets = new ProjectAssets(lib).init(), media = new VideoMedia();
  const catalog = {lib, media, db: lib.db};
  const generic = await new ManagedIntakeCatalog({catalog, assets, dataDir, directory: path.join(dir, 'personal_item')}).init();
  const store = new ProjectMusic({lib, projects, dataDir, directory: path.join(dir, 'personal_item', 'music'), autoMigrate: false}).init();
  const folders = new MusicFolders(store, {dataDir});
  const music = new ProjectMusicIntake(store, folders);
  const trashed = [];
  const trash = async file => { const to = path.join(dir, '.Trash-' + randomUUID() + path.extname(file)); await fs.rename(file, to); trashed.push(file); return to; };
  const preferences = await new IntakePreferences({dataDir, libraryId: dataDir}).init();
  const intake = await new FileIntake({dataDir, catalog, projects, generic, music, trash, preferences}).init();
  const project = projects.save(null, {name: '合成收纳项目'});
  const audio = path.join(dir, '下载'); await fs.mkdir(audio);
  t.after(async () => { await intake.close(); await store.close(); await media.close(); lib.db.close(); await fs.rm(dir, {recursive: true, force: true}); });
  return {dir, dataDir, lib, projects, store, folders, music, intake, project, audio, trashed, preferences};
}

async function settled(intake) {
  const deadline = Date.now() + 15000;
  while (intake.work || intake.status().activeCount) {
    if (Date.now() > deadline) throw Error('收纳没有结束');
    await new Promise(r => setTimeout(r, 10));
  }
  if (intake.lastError) throw intake.lastError;
}

async function confirm(f, files, destinations, mode = 'copy') {
  const h = await f.intake.receipts.handoff(files);
  const input = {version: 2, requestId: randomUUID(), mode, fileIds: h.files.map(x => x.id), targets: h.files.map((x, i) => ({fileId: x.id, destination: destinations[i]}))};
  const batch = await f.intake.confirm(h.id, input);
  await settled(f.intake);
  return {h, input, batch: f.intake.dto(f.intake.batch(batch.id))};
}

test('项目音乐收纳：默认放进「文件」下的文件夹；放进歌曲时同一批新开一轮、上一轮标待 AI 补写；重名只有仍然保留或取消；移动模式按音乐库记录核对', async t => {
  const f = await fixture(t);
  const pid = f.project.id;
  const a = await synth(f.audio, '麦田 (1).mp3', {freq: 330}), b = await synth(f.audio, '麦田.mp3', {freq: 440}), c = await synth(f.audio, '散曲.wav', {freq: 550});
  await f.folders.createFolder(pid, {parent: '', name: 'Suno下载'});

  // 选项：项目音乐的文件夹和进行中的歌（含默认轮次）
  let mp = await f.music.routing(pid);
  assert.deepEqual(mp.folders.map(x => x.id), ['', 'Suno下载']);
  assert.deepEqual(mp.songs, []);

  // 1) 放进「文件 › Suno下载」，复制模式：原文件保留，立即登记进音乐库
  let r = await confirm(f, [c], [{kind: 'music', scope: 'project', projectId: pid, musicFolder: 'Suno下载'}]);
  assert.deepEqual(r.batch.items.map(i => i.status), ['ready'], JSON.stringify(r.batch.items));
  assert.match(r.batch.items[0].destinationLabel, /项目音乐 › 文件 › Suno下载/);
  await fs.access(c);
  let view = await f.folders.list(pid, 'Suno下载');
  assert.deepEqual(view.items.map(i => [i.name, i.inLibrary]), [['散曲.wav', true]]);
  assert.equal(view.items[0].assetId, r.batch.items[0].assetId);
  // 记住项目音乐的文件夹（和收视频一样）；放进歌的不记
  assert.equal(f.preferences.snapshot([{id: pid}]).routingPreferences.lastMusicFolderByProject[pid], 'Suno下载');
  assert.equal(f.preferences.snapshot([{id: pid}]).routingPreferences.lastProjectId.music, pid);

  // 2) 文件名认歌：去掉「(1)」、扩展名和空白后和歌名完全相同
  assert.equal(songKey('麦田 (1).mp3'), songKey('麦田'));
  assert.notEqual(songKey('麦田（副歌）.mp3'), songKey('麦田'));

  // 3) 新建一首歌并新开第 1 轮：两个文件是同一轮的 A、B；带提示词
  r = await confirm(f, [a, b], [
    {kind: 'music', scope: 'project', projectId: pid, newSongTitle: '麦田', newRound: true, roundPrompt: '中国风流行 女声 慢板'},
    {kind: 'music', scope: 'project', projectId: pid, newSongTitle: '麦田', newRound: true, roundPrompt: '中国风流行 女声 慢板'},
  ]);
  assert.deepEqual(r.batch.items.map(i => i.status), ['ready', 'ready'], JSON.stringify(r.batch.items));
  let song = f.store.list(pid).songs[0];
  assert.equal(song.title, '麦田');
  assert.equal(song.rounds.length, 1, '同一批只开一轮');
  assert.deepEqual(song.rounds[0].versions.map(v => v.label), ['A', 'B']);
  assert.equal(song.rounds[0].prompt.style, '中国风流行 女声 慢板');
  assert.equal(song.rounds[0].promptConfirmed.kind, 'user');
  assert.equal(song.rounds[0].versions[0].uploadedBy.kind, 'user');
  assert.equal(song.rounds[0].versions[0].uploadedBy.via, 'finder', '作者记成用户，来自访达');
  await fs.access(a); await fs.access(b);

  // 4) 再从访达开第 2 轮：第 1 轮还没写记录也照样开，第 1 轮标「待 AI 补写」，出现在待补写清单里
  const d1 = await synth(f.audio, '麦田 第二版.mp3', {freq: 660});
  r = await confirm(f, [d1], [{kind: 'music', scope: 'project', projectId: pid, songId: song.id, newRound: true}]);
  assert.equal(r.batch.items[0].status, 'ready', JSON.stringify(r.batch.items));
  song = f.store.song(pid, song.id);
  assert.equal(song.rounds.length, 2);
  assert.ok(song.rounds[0].pendingAgentNotes, '上一轮标成待 AI 补写');
  assert.match(song.rounds[0].pendingAgentNotes.reason, /从访达收纳开了第 2 轮/);
  assert.equal(song.rounds[1].promptConfirmed, null, '没带提示词就不算确认过提示词');
  const pending = f.store.pendingNotes(pid).items;
  assert.deepEqual(pending.map(x => [x.songTitle, x.roundNo, x.missing]), [['麦田', 1, ['issues', 'nextDirection']]]);
  assert.equal(f.store.list(pid).pendingNotes, 1);
  // 页面上开新一轮的规矩不变：仍然先补上一轮
  assert.throws(() => f.store.createRound(pid, song.id, {requestId: randomUUID(), prompt: {}}, {kind: 'user', at: 1}), e => e.code === 'PREVIOUS_ROUND_INCOMPLETE');
  // AI 补完后，待补写自动消失
  const r1 = song.rounds[0];
  f.store.agentNotes(pid, r1.id, {expectedRevision: r1.revision, session: '合成会话', issues: {items: [{text: '副歌偏戏曲', source: 'user_words'}]}, nextDirection: {text: '换风格'}});
  assert.deepEqual(f.store.pendingNotes(pid).items, []);

  // 5) 默认轮次：最新一轮没有版本 → 放进这一轮；否则新开一轮
  mp = await f.music.routing(pid);
  assert.deepEqual(mp.songs[0].defaultRound, {newRound: true});
  {
    const r2 = f.store.song(pid, song.id).rounds[1];
    f.store.agentNotes(pid, r2.id, {expectedRevision: r2.revision, session: '合成会话', issues: {items: [{text: '前奏太长', source: 'user_words'}]}, nextDirection: {text: '缩短前奏'}});
  }
  song = f.store.createRound(pid, song.id, {requestId: randomUUID(), session: '合成会话', prompt: {style: 'AI 开好的第 3 轮'}}, {kind: 'agent', session: '合成会话', at: 1});
  mp = await f.music.routing(pid);
  const r3 = song.rounds.at(-1);
  assert.deepEqual(mp.songs[0].defaultRound, {roundId: r3.id});

  // 6) 同一项目已收过同样内容：先停下来；不给复用和覆盖；「仍然保留」后完成
  r = await confirm(f, [b], [{kind: 'music', scope: 'project', projectId: pid, songId: song.id, roundId: r3.id}]);
  const dup = r.batch.items[0];
  assert.equal(dup.status, 'duplicate', JSON.stringify(dup));
  assert.match(dup.candidates[0].name, /「麦田」第 1 轮 B/);
  await assert.rejects(() => f.intake.resolve(r.batch.id, dup.id, {choice: 'reuse', candidateId: dup.candidates[0].id}), e => e.code === 'INVALID_CHOICE');
  await assert.rejects(() => f.intake.resolve(r.batch.id, dup.id, {choice: 'overwrite', candidateId: dup.candidates[0].id}), e => e.code === 'INVALID_CHOICE');
  const kept = await f.intake.resolve(r.batch.id, dup.id, {choice: 'import'});
  assert.equal(kept.items[0].status, 'ready', JSON.stringify(kept.items[0]));
  assert.equal(f.store.song(pid, song.id).rounds.at(-1).versions[0].library.reused, true);

  // 7) 移动模式：放进「文件」的新文件，核对音乐库记录后把原件送进废纸篓；复用已有记录的保留原件
  const e = await synth(f.audio, '剪辑稿.wav', {freq: 770});
  r = await confirm(f, [e], [{kind: 'music', scope: 'project', projectId: pid, musicFolder: ''}], 'move');
  assert.equal(r.batch.items[0].status, 'ready', JSON.stringify(r.batch.items));
  assert.deepEqual(f.trashed, [e]);
  const copyOfA = path.join(f.dir, '麦田副本.mp3'); await fs.copyFile(a, copyOfA);
  r = await confirm(f, [copyOfA], [{kind: 'music', scope: 'project', projectId: pid, songId: song.id, roundId: r3.id}], 'move');
  assert.equal(r.batch.items[0].status, 'duplicate');
  const moved = await f.intake.resolve(r.batch.id, r.batch.items[0].id, {choice: 'import'});
  assert.equal(moved.items[0].status, 'source_retained', JSON.stringify(moved.items[0]));
  await fs.access(copyOfA);

  // 8) 不合规的目标：放进歌曲时改文件名、往「歌曲」系统文件夹里放、文件夹不存在
  const g = await synth(f.audio, '其他.mp3', {freq: 880});
  for (const [d, code] of [
    [{kind: 'music', scope: 'project', projectId: pid, songId: song.id, roundId: r3.id, fileName: '改名.mp3'}, 'INTAKE_INVALID_INPUT'],
    [{kind: 'music', scope: 'project', projectId: pid, musicFolder: '歌曲'}, 'INTAKE_INVALID_INPUT'],
    [{kind: 'music', scope: 'project', projectId: pid, musicFolder: '没有这个'}, 'FOLDER_NOT_FOUND'],
    [{kind: 'sfx', scope: 'project', projectId: pid, musicFolder: ''}, 'INVALID_DESTINATION'],
  ]) await assert.rejects(() => confirm(f, [g], [d]), err => err.code === code);
  assert.equal(f.store.song(pid, song.id).rounds.length, 3, '被拒的那批没有多开一轮');

  // 9) 收纳端重试前取消一份还在 waiting 的旧回执（项目音乐自己只允许 duplicate 时取消）
  const t1 = await f.music.prepare({kind: 'music', scope: 'project', projectId: pid, musicFolder: ''});
  const bound = f.music.bind({kind: 'music', scope: 'project', projectId: pid, musicFolder: ''}, t1);
  const req = randomUUID();
  assert.equal(bound.startIntake(pid, {requestId: req, fileName: '等待中.mp3', bytes: 10}).status, 'waiting');
  const cancelled = await bound.resolve(pid, req, {choice: 'cancel'});
  assert.equal(cancelled.status, 'failed');
  assert.equal(cancelled.error, '已取消本次操作');
  assert.equal(bound.receipt(pid, req).published, false, 'reconcile 读得到 published');
  assert.throws(() => bound.receipt(randomUUID(), req), err => err.code === 'TARGET_CHANGED');
  // 收进来的文件内容和原件一致
  const placed = (await f.folders.list(pid, '')).items.find(i => i.name === '剪辑稿.wav');
  assert.ok(placed);
  assert.equal(sha(await fs.readFile(path.join(f.dir, 'personal_item', 'music', `合成收纳项目--${pid}`, '剪辑稿.wav'))), sha(await fs.readFile(f.trashed.length ? (await fs.readdir(f.dir)).map(n => path.join(f.dir, n)).find(p => p.includes('.Trash-') && p.endsWith('.wav')) : e)));
});

test('项目音乐收纳：粘进整段 Suno 提示词，拆成风格和歌词，歌词和段落标记不进音乐库标签（验收 PR5 P3-1）', async t => {
  const f = await fixture(t);
  const pid = f.project.id;
  const a = await synth(f.audio, '雨巷.mp3', {freq: 360});
  const prompt = '中国风, 女声\n[Verse]\n雨巷里的油纸伞\n[Chorus]\n丁香一样的姑娘';
  const r = await confirm(f, [a], [{kind: 'music', scope: 'project', projectId: pid, newSongTitle: '雨巷', newRound: true, roundPrompt: prompt}]);
  assert.equal(r.batch.items[0].status, 'ready', JSON.stringify(r.batch.items));
  let song = f.store.list(pid).songs[0];
  assert.equal(song.rounds[0].prompt.style, '中国风, 女声');
  assert.equal(song.rounds[0].prompt.lyrics, '[Verse]\n雨巷里的油纸伞\n[Chorus]\n丁香一样的姑娘');
  for (let i = 0; i < 400 && (f.store.tagQueue.size || f.store.tagRunning || f.store.tagTimer); i++) await new Promise(r => setTimeout(r, 10));
  const tags = f.lib.asset(song.rounds[0].versions[0].library.assetId).tags;
  assert.ok(tags.includes('中国风') && tags.includes('女声'), String(tags));
  for (const bad of ['[Verse]', '[Chorus]', '雨巷里的油纸伞', '丁香一样的姑娘']) assert.ok(!tags.includes(bad), bad + ' 变成了标签：' + tags);
});

test('项目音乐收纳：放进歌曲只收 mp3、wav、m4a、flac，格式不对时确认就挡下并说清；放进「文件」照收', async t => {
  const f = await fixture(t);
  const pid = f.project.id;
  const ogg = path.join(f.audio, '小样.ogg');
  await fs.copyFile(await synth(f.audio, '小样.wav', {freq: 420}), ogg);
  await assert.rejects(() => confirm(f, [ogg], [{kind: 'music', scope: 'project', projectId: pid, newSongTitle: '小样', newRound: true}]),
    e => e.code === 'UNSUPPORTED_FORMAT' && /这个格式不能放进歌曲对比，请先转成 mp3\/wav\/m4a\/flac/.test(e.message));
  assert.equal(f.store.list(pid).songs.length, 0, '被拒的那批没有建歌');
  const r = await confirm(f, [ogg], [{kind: 'music', scope: 'project', projectId: pid, musicFolder: ''}]);
  assert.equal(r.batch.items[0].status, 'ready', JSON.stringify(r.batch.items));
});

// 在第 2 个文件的某一步真把子进程杀掉，重启后核对、重试，应该全部收好、没有 -2、没有残留的 .partial（验收 PR5 P3-2）。
for (const target of ['song', 'files']) for (const stage of ['before-publish', 'after-publish', 'after-register']) {
  test(`项目音乐收纳中途被杀：${target === 'song' ? '放进歌曲' : '放进文件'} · ${stage}，重启后能恢复`, async t => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sg-pm-intake-crash-')));
    t.after(() => fs.rm(dir, {recursive: true, force: true}));
    const child = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures', 'project-music-intake-crash.mjs'), dir, stage, target], {stdio: ['ignore', 'pipe', 'pipe']});
    let err = ''; child.stderr.on('data', b => { err += b; }); child.stdout.on('data', () => {});
    const [code, signal] = await once(child, 'exit');
    assert.equal(signal, 'SIGKILL', `子进程应在 ${stage} 被杀：code=${code} ${err}`);
    const state = JSON.parse(await fs.readFile(path.join(dir, 'state.json'), 'utf8'));
    const f = await openIntakeFixture(dir);
    t.after(() => f.close());
    await recovered(f.store);
    let batch = await f.intake.reconcile(state.batchId);
    assert.deepEqual(batch.items.map(i => i.status).filter(s => s === 'unknown'), [], '核对后不应停在「待核对」：' + JSON.stringify(batch.items.map(i => [i.name, i.status, i.error])));
    for (const i of batch.items) if (i.status === 'failed') batch = await f.intake.retry(state.batchId, i.id);
    await intakeSettled(f.intake);
    batch = f.intake.dto(f.intake.batch(state.batchId));
    assert.deepEqual(batch.items.map(i => i.status), ['ready', 'ready', 'ready'], JSON.stringify(batch.items.map(i => [i.name, i.status, i.error])));
    const projectDir = path.join(dir, 'personal_item', 'music', `合成中断项目--${state.projectId}`);
    let names;
    if (target === 'song') {
      const song = f.store.list(state.projectId).songs[0];
      assert.equal(song.rounds.length, 1, '重试不会多开一轮');
      assert.deepEqual(song.rounds[0].versions.map(v => v.label).sort(), ['A', 'B', 'C']);
      names = (await fs.readdir(path.join(projectDir, '歌曲', '中断歌', '第01轮'))).sort();
      assert.equal(names.length, 3, '没有没人引用的多余文件：' + names);
    } else {
      names = (await fs.readdir(path.join(projectDir, 'Suno下载'))).sort();
      assert.deepEqual(names, ['一.mp3', '三.mp3', '二.mp3'].sort());
      for (const n of names) assert.ok(f.lib.db.prepare('SELECT id FROM assets WHERE path=?').get(path.join(await fs.realpath(projectDir), 'Suno下载', n)), n + ' 已登记');
    }
    assert.ok(names.every(n => !/-2\./.test(n)), '没有 -2 副本：' + names);
    const incoming = await fs.readdir(path.join(dir, 'personal_item', 'music', '.incoming')).catch(() => []);
    assert.deepEqual(incoming.filter(n => n.endsWith('.partial')), [], '.incoming 里没有残留');
  });
}
