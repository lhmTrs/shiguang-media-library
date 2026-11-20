// 项目音乐：同一套场景分别跑在全新 SQLite 和自起的临时 mysqld 上，结果逐项对比（SPEC 第八节「SQLite 和原生 MySQL 行为一致」）。
// 用法：PROJECT_MUSIC_MYSQLD=/path/to/mysqld node tests/project-music-mysql.mjs
// 没给 mysqld 时只跑 SQLite 一半，输出「MySQL 未运行」并以退出码 3 结束，不算通过。
// 只用合成音频和临时目录；不连接作者的数据库，不读取任何连接配置。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import mysql from 'mysql2/promise';
import {Library} from '../server/library.mjs';
import {MysqlDatabase} from '../server/mysql-db.mjs';
import {MysqlStorage} from '../server/mysql.mjs';
import {Projects} from '../server/projects.mjs';
import {ProjectMusic} from '../server/project-music/store.mjs';
import {MusicFolders} from '../server/project-music/folders.mjs';
import {projectFolderName as projectFolder} from '../server/prompt-codex/pictures.mjs';

process.env.MEDIA_SKIP_IMPORT = '1'; process.env.MEDIA_SKIP_RECONCILE = '1'; process.env.MEDIA_NO_WATCH = '1'; process.env.SHIGUANG_AUDIO_ANALYSIS = '0';
const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sg-project-music-mysql-')));
const page = {kind: 'user', at: 1};
const bounded = async (p, ms, label) => { let t; try { return await Promise.race([p, new Promise((_, j) => { t = setTimeout(() => j(Error(label)), ms); })]); } finally { clearTimeout(t); } };
const code = async (fn) => { try { await fn(); return 'OK'; } catch (e) { return e.code ?? e.message; } };

const audio = path.join(base, 'audio'); await fs.mkdir(audio);
const synth = (name, freq) => { const f = path.join(audio, name); execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=2`, '-c:a', 'libmp3lame', '-b:a', '64k', '-y', f]); return f; };
const fileA = synth('甲.mp3', 330), fileB = synth('乙.mp3', 440);

const settled = async store => { for (let i = 0; i < 1000 && (store.tagQueue.size || store.tagRunning || store.tagTimer); i++) await new Promise(r => setTimeout(r, 10)); };

async function scenario(lib, dataDir) {
  const projects = new Projects(lib).init();
  const directory = path.join(dataDir + '-personal', 'music');
  const store = new ProjectMusic({lib, projects, dataDir, directory}).init();
  new ProjectMusic({lib, projects, dataDir, directory, autoMigrate: false}).init(); // 建表可重复执行
  const p = projects.save(null, {name: '合成项目' + randomUUID().slice(0, 6)});
  const out = {};
  let song = store.createSong(p.id, {requestId: randomUUID(), title: '合成歌曲'}, page);
  song = store.createRound(p.id, song.id, {requestId: randomUUID(), prompt: {tool: 'Suno', style: '合成风格', lyrics: '一\n二'}}, page);
  const r1 = song.rounds[0];
  const up = async file => {
    const bytes = await fs.readFile(file), id = randomUUID();
    store.startImport(p.id, {requestId: id, roundId: r1.id, fileName: path.basename(file), bytes: bytes.length}, page);
    return {id, receipt: await store.upload(p.id, id, Readable.from([bytes]))};
  };
  out.uploads = [(await up(fileA)).receipt.status, (await up(fileB)).receipt.status];
  const dup = await up(fileA);
  out.duplicate = dup.receipt.status;
  out.keep = (await store.resolveImport(p.id, dup.id, {choice: 'keep'})).label;
  song = store.song(p.id, song.id);
  out.labels = song.rounds[0].versions.map(v => v.label);
  // PR3：全部进音乐库「AI生成」，主类是项目、子类是歌曲；「仍然保留」复用同一条记录；标签写进音乐库
  await settled(store);
  song = store.song(p.id, song.id);
  const vs = song.rounds[0].versions;
  out.library = vs.map(v => [v.library.inLibrary, v.library.reused, v.library.sub, v.library.category === projectFolder(p), v.library.tagSync]);
  out.sharedAsset = vs[0].library.assetId === vs[2].library.assetId;
  out.root = lib.roots().filter(r => r.name === 'AI生成').map(r => r.kind);
  out.tags = lib.asset(vs[0].library.assetId).tags.filter(t => t !== p.name).sort(); // 项目名每次随机，不参与两库对比
  out.peaks = song.rounds[0].versions.every(v => v.peaks?.length === 300);
  out.gate = await code(() => store.createRound(p.id, song.id, {requestId: randomUUID(), prompt: {}}, page));
  let round = song.rounds[0];
  out.forbidden = await code(() => store.agentNotes(p.id, round.id, {expectedRevision: round.revision, session: 's', listening: []}));
  song = store.agentNotes(p.id, round.id, {expectedRevision: round.revision, session: '合成会话',
    issues: {items: [{text: '问题', source: 'user_words', causeGuess: '猜测'}]}, nextDirection: {text: '方向', promptDraft: {style: '新', lyrics: '', params: ''}}});
  round = song.rounds[0];
  out.notesRevision = round.revision;
  out.stale = await code(() => store.agentNotes(p.id, round.id, {expectedRevision: 1, session: 's', changes: {text: 'x'}}));
  song = store.createRound(p.id, song.id, {requestId: randomUUID(), session: 'x', prompt: {style: '新'}}, {kind: 'agent', session: '合成会话', at: 1});
  out.rounds = song.rounds.map(r => [r.roundNo, r.promptConfirmed ? 'user' : 'draft', r.promptDiffFromPrevious]);
  out.uniqueRoundNo = (await code(() => lib.db.prepare('INSERT INTO project_music_rounds(id,project_id,song_id,round_no,data_json,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), p.id, song.id, 1, '{}', 1, 1, 1))) === 'OK' ? 'accepted' : 'rejected';
  const [A] = song.rounds[0].versions;
  song = store.updateSong(p.id, song.id, {expectedRevision: song.revision, bestVersionId: A.id});
  out.rejectBest = await code(() => store.updateVersion(p.id, A.id, {expectedRevision: A.revision, status: 'rejected'}));
  song = store.updateVersion(p.id, A.id, {expectedRevision: A.revision, status: 'rejected', clearBest: true});
  out.afterReject = [song.bestVersionId, song.rounds[0].versions.find(v => v.id === A.id).status];
  song = store.updateVersion(p.id, A.id, {expectedRevision: A.revision + 1, status: 'candidate'});
  out.restored = song.rounds[0].versions.find(v => v.id === A.id).status;
  // 淘汰 B（不共用文件）：音乐库标「未选用」；AI 按原话改当前最好，再一键改回
  const B0 = song.rounds[0].versions.find(v => v.label === 'B');
  song = store.updateVersion(p.id, B0.id, {expectedRevision: B0.revision, status: 'rejected'});
  await settled(store);
  out.unused = lib.asset(B0.library.assetId).tags.filter(t => t === `未选用（${p.name}）`).length;
  let rd = store.song(p.id, song.id).rounds[0];
  song = store.agentNotes(p.id, rd.id, {expectedRevision: rd.revision, session: '合成会话', decisions: [{versionId: A.id, action: 'best', userWords: '甲最好'}],
    measurements: [{versionId: A.id, bpm: 100, method: '合成'}]});
  const decision = song.decisions.at(-1);
  out.decision = [song.bestVersionId === A.id, decision.action, decision.userWords, decision.canUndo];
  song = store.undoDecision(p.id, song.id, decision.id, {expectedRevision: song.revision});
  out.undone = [song.bestVersionId, !!song.decisions.at(-1).undone];
  await settled(store);
  out.measuredTag = lib.asset(A.library.assetId).tags.includes('100 BPM');
  const opened = await store.openVersion(p.id, A.id);
  out.openBytes = (await opened.handle.stat()).size === (await fs.stat(fileA)).size;
  await opened.handle.close();
  // PR2：AI 歌词时间与对比结果
  let rr = store.song(p.id, song.id).rounds[0];
  const [va, vb] = rr.versions;
  store.agentNotes(p.id, rr.id, {expectedRevision: rr.revision, session: '合成会话', lyricTimes: [{versionId: va.id, method: '合成', lines: [{text: '一', startMs: 100}, {text: '二', startMs: 900}]}]});
  song = store.createComparison(p.id, song.id, {requestId: randomUUID(), leftVersionId: va.id, rightVersionId: vb.id, blind: true, summary: '副歌 2 号好', winner: 'right', markers: [{label: '副歌', ms: 800}], segments: [{label: '副歌', winner: 'right'}]});
  const cmp = song.rounds[0].comparisons[0];
  out.comparison = [cmp.left.label, cmp.right.label, cmp.blind, cmp.winner, cmp.summary, cmp.markers.length, cmp.segments[0].winner];
  out.lyric = song.rounds[0].versions[0].lyricTimes?.lines.map(l => l.startMs);
  out.comparisonEmpty = await code(() => store.createComparison(p.id, song.id, {requestId: randomUUID(), leftVersionId: va.id, rightVersionId: vb.id}));
  // PR5：从访达开新一轮，上一轮没写完也能开，上一轮进「待补写」清单
  song = store.createRound(p.id, song.id, {requestId: randomUUID(), prompt: {style: '访达开的一轮'}}, {kind: 'user', at: 1, via: 'finder'}, {fromIntake: true});
  out.pending = [song.rounds.length, store.pendingNotes(p.id).items.map(x => [x.roundNo, x.missing.join('+')]), !!song.rounds.at(-2).pendingAgentNotes];
  // PR4「文件」区：建文件夹、放文件、加入歌曲（登记进音乐库）、改名后音乐库记录路径跟着改（用到 LIKE … ESCAPE）
  const folders = new MusicFolders(store, {dataDir});
  await folders.createFolder(p.id, {parent: '', name: 'Suno_下载%'});
  const projectDir = path.join(directory, projectFolder(p));
  await fs.copyFile(fileB, path.join(projectDir, 'Suno_下载%', '乙副本.mp3'));
  await fs.appendFile(path.join(projectDir, 'Suno_下载%', '乙副本.mp3'), Buffer.alloc(16));
  let rr2 = store.song(p.id, song.id).rounds.at(-1);
  song = await folders.addToSong(p.id, {requestId: randomUUID(), path: 'Suno_下载%/乙副本.mp3', roundId: rr2.id}, page);
  const added = song.rounds.at(-1).versions.at(-1);
  const renamed = await folders.renameFolder(p.id, {path: 'Suno_下载%', name: '下载合集'});
  out.files = [renamed.folder, renamed.items.map(i => [i.name, i.inLibrary, i.inSongs.length]), lib.asset(added.library.assetId).path.endsWith(path.join('下载合集', '乙副本.mp3')), lib.asset(added.library.assetId).sub];
  // 定稿：只做标记，加入项目候选
  song = store.finalize(p.id, song.id, {requestId: randomUUID(), expectedRevision: song.revision, versionId: va.id});
  out.final = [song.status, song.final.assetId === va.library.assetId, lib.db.prepare('SELECT status FROM project_assets WHERE project_id=? AND asset_id=?').get(p.id, song.final.assetId)?.status];
  out.songRevision = song.revision;
  await store.close();
  return {out, projectId: p.id, projects, dataDir};
}

const result = {sqlite: null, mysql: null, mysqlRun: false, version: null};
let server, connection, mysqlDb, sqliteLib, passed = false, logs = '';
try {
  const sqliteApp = path.join(base, 'sqlite-app');
  const storage = await new MysqlStorage(sqliteApp).init();
  sqliteLib = await new Library(sqliteApp, {directoryClassification: true}).init();
  storage.attach(sqliteLib);
  const sqliteRun = await scenario(sqliteLib, sqliteApp);
  result.sqlite = sqliteRun.out;
  console.log('SQLite', JSON.stringify(result.sqlite));
  const binary = process.env.PROJECT_MUSIC_MYSQLD || process.env.CREATIVE_MYSQLD;
  if (!binary) {
    console.log('MySQL 未运行：没有提供 PROJECT_MUSIC_MYSQLD。本次只验证了 SQLite 一半，不能写成「两库一致」。');
  } else {
    const data = path.join(base, 'mysql'); await fs.mkdir(data, {mode: 0o700});
    const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r));
    const init = spawn(binary, ['--no-defaults', '--initialize-insecure', '--datadir=' + data], {stdio: ['ignore', 'pipe', 'pipe']});
    init.stdout.on('data', b => { logs += b; }); init.stderr.on('data', b => { logs += b; });
    assert.equal((await bounded(once(init, 'exit'), 60000, 'mysqld 初始化超时'))[0], 0, logs);
    server = spawn(binary, ['--no-defaults', '--datadir=' + data, '--port=' + port, '--bind-address=127.0.0.1', '--socket=' + path.join(base, 'mysql.sock'), '--pid-file=' + path.join(base, 'mysql.pid'), '--mysqlx=OFF'], {stdio: ['ignore', 'pipe', 'pipe']});
    server.stdout.on('data', b => { logs += b; }); server.stderr.on('data', b => { logs += b; });
    const config = {host: '127.0.0.1', port, user: 'root', password: ''};
    for (let i = 0; i < 150 && !connection; i++) { try { connection = await mysql.createConnection({...config, connectTimeout: 500}); } catch { if (server.exitCode !== null) throw Error('mysqld 已退出\n' + logs); await new Promise(r => setTimeout(r, 150)); } }
    assert.ok(connection, 'mysqld 没有就绪');
    result.version = (await connection.query('SELECT VERSION() v'))[0][0].v;
    // 和正式环境一样：先起一个全新的 SQLite 库，再切到 MySQL（建出 assets、roots 等全部表），然后跑同一场景。
    const appDir = path.join(base, 'mysql-app'); await fs.mkdir(appDir);
    const mysqlStorage = await new MysqlStorage(appDir).init();
    const mysqlLib = await new Library(appDir, {directoryClassification: true}).init();
    mysqlStorage.attach(mysqlLib);
    await mysqlStorage.activate({...config, database: 'project_music_check'});
    assert.equal(mysqlLib.db.kind, 'mysql');
    mysqlDb = mysqlLib.db;
    result.mysql = (await scenario(mysqlLib, appDir)).out;
    result.mysqlRun = true;
    console.log('MySQL ' + result.version, JSON.stringify(result.mysql));
    const [cols] = await connection.query("SELECT TABLE_NAME t, COLUMN_NAME c, COLUMN_TYPE ty FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='project_music_check' AND TABLE_NAME LIKE 'project_music_%' AND COLUMN_NAME IN ('id','sha256','data_json','round_no')");
    result.mysqlColumns = cols.map(r => `${r.t}.${r.c}=${r.ty}`).sort();
    const [idx] = await connection.query("SELECT DISTINCT TABLE_NAME t, INDEX_NAME i FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='project_music_check' AND TABLE_NAME LIKE 'project_music_%'");
    result.mysqlIndexes = idx.map(r => `${r.t}.${r.i}`).sort();
    console.log(JSON.stringify({columns: result.mysqlColumns, indexes: result.mysqlIndexes}));
    assert.deepEqual(result.mysql, result.sqlite, 'SQLite 与 MySQL 的行为不一致');
    // 一次性迁移（server/mysql.mjs）：SQLite 里的项目音乐原样进 MySQL，读出来和迁移前一致。
    const opts = {lib: sqliteLib, projects: sqliteRun.projects, dataDir: sqliteApp, directory: path.join(sqliteApp + '-personal', 'music'), autoMigrate: false};
    const before = new ProjectMusic(opts).init().list(sqliteRun.projectId);
    await storage.activate({...config, database: 'project_music_migration'});
    assert.equal(sqliteLib.db.kind, 'mysql');
    const after = new ProjectMusic(opts).init().list(sqliteRun.projectId);
    assert.deepEqual(after, before, '迁移到 MySQL 后项目音乐数据不一致');
    const [migrated] = await connection.query("SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA='project_music_migration' AND TABLE_NAME LIKE 'project_music_%'");
    result.migratedTables = migrated.map(r => r.t).sort();
    assert.equal(result.migratedTables.length, 5, '五张项目音乐表都迁移了');
    const [uniq] = await connection.query("SELECT INDEX_NAME i FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='project_music_migration' AND TABLE_NAME='project_music_rounds' AND NON_UNIQUE=0 AND COLUMN_NAME='round_no'");
    assert.ok(uniq.length, '迁移后的轮次表保留唯一约束');
    result.migration = 'OK';
    assert.ok(result.mysqlColumns.includes('project_music_versions.sha256=char(64)'));
    assert.ok(result.mysqlColumns.includes('project_music_songs.data_json=longtext'));
  }
  assert.deepEqual(result.sqlite.uploads, ['ready', 'ready']);
  assert.equal(result.sqlite.duplicate, 'duplicate');
  assert.equal(result.sqlite.gate, 'PREVIOUS_ROUND_INCOMPLETE');
  assert.equal(result.sqlite.forbidden, 'AGENT_FIELD_FORBIDDEN');
  assert.equal(result.sqlite.stale, 'REVISION_CONFLICT');
  assert.equal(result.sqlite.rejectBest, 'VERSION_IS_BEST');
  assert.equal(result.sqlite.uniqueRoundNo, 'rejected', '同一首歌的轮次编号必须唯一');
  assert.ok(result.sqlite.library.every(([inLib, , sub, cat, tags]) => inLib && sub === '歌曲' && cat && tags === 'done'), JSON.stringify(result.sqlite.library));
  assert.equal(result.sqlite.sharedAsset, true);
  assert.deepEqual(result.sqlite.root, ['music']);
  assert.ok(['AI生成', '合成歌曲', '第1轮', '合成风格'].every(t => result.sqlite.tags.includes(t)), result.sqlite.tags.join(','));
  assert.equal(result.sqlite.unused, 1);
  assert.deepEqual(result.sqlite.decision, [true, 'best', '甲最好', true]);
  assert.deepEqual(result.sqlite.undone, [null, true]);
  assert.equal(result.sqlite.measuredTag, true);
  assert.deepEqual(result.sqlite.final, ['final', true, 'candidate']);
  assert.deepEqual(result.sqlite.files, ['下载合集', [['乙副本.mp3', true, 1]], true, '下载合集']);
  assert.deepEqual(result.sqlite.pending, [3, [[2, 'issues+nextDirection']], true]);
  passed = true;
} finally {
  if (mysqlDb) { const done = mysqlDb.worker.threadId === -1 ? Promise.resolve() : once(mysqlDb.worker, 'exit'); mysqlDb.close(); await bounded(done, 10000, 'MySQL worker 未退出').catch(() => {}); }
  if (sqliteLib?.db?.kind === 'mysql') { const done = sqliteLib.db.worker.threadId === -1 ? Promise.resolve() : once(sqliteLib.db.worker, 'exit'); sqliteLib.db.close(); await bounded(done, 10000, 'MySQL worker 未退出').catch(() => {}); }
  else if (sqliteLib?.db?.open) sqliteLib.db.close();
  await connection?.end().catch(() => {});
  if (server && server.exitCode === null) { const done = once(server, 'exit'); server.kill('SIGTERM'); await bounded(done, 20000, 'mysqld 未退出'); }
  const known = !server || server.exitCode !== null || server.signalCode !== null;
  console.log(JSON.stringify({passed, mysqlRun: result.mysqlRun, migration: result.migration ?? 'not-run', mysqlVersion: result.version, mysqldStopped: known, tempRemoved: passed && known, ...(passed && known ? {} : {retained: base})}));
  if (passed && known) await fs.rm(base, {recursive: true, force: true});
  // 3 = SQLite 一半通过但 MySQL 没跑，不能当作「两库一致」。
  process.exitCode = passed ? (result.mysqlRun ? 0 : 3) : 1;
}
