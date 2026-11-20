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
import {Projects} from '../server/projects.mjs';
import {ProjectMusic} from '../server/project-music/store.mjs';

process.env.MEDIA_SKIP_IMPORT = '1'; process.env.MEDIA_SKIP_RECONCILE = '1'; process.env.MEDIA_NO_WATCH = '1'; process.env.SHIGUANG_AUDIO_ANALYSIS = '0';
const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sg-project-music-mysql-')));
const page = {kind: 'user', at: 1};
const bounded = async (p, ms, label) => { let t; try { return await Promise.race([p, new Promise((_, j) => { t = setTimeout(() => j(Error(label)), ms); })]); } finally { clearTimeout(t); } };
const code = async (fn) => { try { await fn(); return 'OK'; } catch (e) { return e.code ?? e.message; } };

const audio = path.join(base, 'audio'); await fs.mkdir(audio);
const synth = (name, freq) => { const f = path.join(audio, name); execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=2`, '-c:a', 'libmp3lame', '-b:a', '64k', '-y', f]); return f; };
const fileA = synth('甲.mp3', 330), fileB = synth('乙.mp3', 440);

async function scenario(lib, dataDir) {
  const projects = new Projects(lib).init();
  const store = new ProjectMusic({lib, projects, dataDir}).init();
  new ProjectMusic({lib, projects, dataDir}).init(); // 建表可重复执行
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
  const opened = await store.openVersion(p.id, A.id);
  out.openBytes = (await opened.handle.stat()).size === (await fs.stat(fileA)).size;
  await opened.handle.close();
  out.songRevision = song.revision;
  return out;
}

const result = {sqlite: null, mysql: null, mysqlRun: false, version: null};
let server, connection, mysqlDb, sqliteLib, passed = false, logs = '';
try {
  sqliteLib = await new Library(path.join(base, 'sqlite-app'), {directoryClassification: true}).init();
  result.sqlite = await scenario(sqliteLib, path.join(base, 'sqlite-app'));
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
    await connection.query('CREATE DATABASE project_music_check CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
    mysqlDb = new MysqlDatabase({...config, database: 'project_music_check'});
    const appDir = path.join(base, 'mysql-app'); await fs.mkdir(appDir);
    result.mysql = await scenario({db: mysqlDb, dataDir: appDir, asset: () => { throw Error('素材不存在'); }, roots: () => []}, appDir);
    result.mysqlRun = true;
    console.log('MySQL ' + result.version, JSON.stringify(result.mysql));
    const [cols] = await connection.query("SELECT TABLE_NAME t, COLUMN_NAME c, COLUMN_TYPE ty FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='project_music_check' AND TABLE_NAME LIKE 'project_music_%' AND COLUMN_NAME IN ('id','sha256','data_json','round_no')");
    result.mysqlColumns = cols.map(r => `${r.t}.${r.c}=${r.ty}`).sort();
    const [idx] = await connection.query("SELECT DISTINCT TABLE_NAME t, INDEX_NAME i FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='project_music_check' AND TABLE_NAME LIKE 'project_music_%'");
    result.mysqlIndexes = idx.map(r => `${r.t}.${r.i}`).sort();
    console.log(JSON.stringify({columns: result.mysqlColumns, indexes: result.mysqlIndexes}));
    assert.deepEqual(result.mysql, result.sqlite, 'SQLite 与 MySQL 的行为不一致');
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
  passed = true;
} finally {
  if (mysqlDb) { const done = mysqlDb.worker.threadId === -1 ? Promise.resolve() : once(mysqlDb.worker, 'exit'); mysqlDb.close(); await bounded(done, 10000, 'MySQL worker 未退出').catch(() => {}); }
  if (sqliteLib?.db?.open) sqliteLib.db.close();
  await connection?.end().catch(() => {});
  if (server && server.exitCode === null) { const done = once(server, 'exit'); server.kill('SIGTERM'); await bounded(done, 20000, 'mysqld 未退出'); }
  const known = !server || server.exitCode !== null || server.signalCode !== null;
  console.log(JSON.stringify({passed, mysqlRun: result.mysqlRun, mysqlVersion: result.version, mysqldStopped: known, tempRemoved: passed && known, ...(passed && known ? {} : {retained: base})}));
  if (passed && known) await fs.rm(base, {recursive: true, force: true});
  // 3 = SQLite 一半通过但 MySQL 没跑，不能当作「两库一致」。
  process.exitCode = passed ? (result.mysqlRun ? 0 : 3) : 1;
}
