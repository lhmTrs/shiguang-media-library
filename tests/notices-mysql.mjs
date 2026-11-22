// 待处理：同一套场景分别跑在全新 SQLite 和自起的临时 mysqld 上，结果逐项对比；再验证 SQLite→MySQL 一次性迁移带上 notices 表。
// 用法：NOTICES_MYSQLD=/path/to/mysqld node tests/notices-mysql.mjs   （也认 PROJECT_MUSIC_MYSQLD）
// 没给 mysqld 时只跑 SQLite 一半，输出「MySQL 未运行」并以退出码 3 结束，不算通过。
// 只用合成数据和临时目录；不连接作者的数据库，不读取任何连接配置。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import mysql from 'mysql2/promise';
import {Library} from '../server/library.mjs';
import {MysqlStorage} from '../server/mysql.mjs';
import {Projects} from '../server/projects.mjs';
import {ProjectMusic} from '../server/project-music/store.mjs';
import {Notices} from '../server/notices/store.mjs';
import {projectMusicSource} from '../server/notices/project-music-source.mjs';
import {activateAndRestart} from './helpers/mysql-activate.mjs';

process.env.MEDIA_SKIP_IMPORT = '1'; process.env.MEDIA_SKIP_RECONCILE = '1'; process.env.MEDIA_NO_WATCH = '1'; process.env.SHIGUANG_AUDIO_ANALYSIS = '0';
const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sg-notices-mysql-')));
const bounded = async (p, ms, label) => { let t; try { return await Promise.race([p, new Promise((_, j) => { t = setTimeout(() => j(Error(label)), ms); })]); } finally { clearTimeout(t); } };
const code = async fn => { try { await fn(); return 'OK'; } catch (e) { return e.code ?? e.message; } };
// 编号、时间每次不同：换成稳定的形状再比
const shape = n => ({source: n.source, key: n.key.startsWith('job-') ? n.key : '<roundId>', attempt: n.attempt, kind: n.kind, status: n.status, group: n.group, awaitingUser: n.awaitingUser,
  typeLabel: n.typeLabel, title: n.title.replace(/合成项目[0-9a-f]{6}/, '合成项目'), costNote: n.costNote, owner: n.owner, unassigned: n.unassigned, links: n.links.map(l => ({...l, projectId: l.projectId ? '<project>' : null})),
  decision: n.decision?.action ?? null, result: n.result?.state ?? null, resolution: n.resolution?.note ?? null, hasPrev: !!n.previousId, hasNext: !!n.nextId,
  history: n.history.map(h => h.event + ':' + h.by), revision: n.revision});

async function scenario(lib, dataDir) {
  let clock = Date.now();
  const now = () => clock;
  const projects = new Projects(lib).init();
  const music = new ProjectMusic({lib, projects, dataDir, directory: path.join(dataDir + '-personal', 'music'), autoMigrate: false}).init();
  const notices = new Notices({lib, now}).init().registerSource('project-music', projectMusicSource(music));
  new Notices({lib, now}).init(); // 建表可重复执行
  const out = {};
  const p = projects.save(null, {name: '合成项目' + randomUUID().slice(0, 6)});
  const page = {kind: 'user', at: 1};
  let song = music.createSong(p.id, {requestId: randomUUID(), title: '合成歌曲'}, page);
  song = music.createRound(p.id, song.id, {requestId: randomUUID(), prompt: {tool: 'Suno', style: '合成'}}, page);
  song = music.createRound(p.id, song.id, {requestId: randomUUID()}, page, {fromIntake: true});
  const card = (key, over = {}) => ({source: 'synthetic-runner', key, kind: 'decision', typeLabel: '生成失败 · 超时', title: '合成 · S2 镜', costNote: '重做约花 1 次生成费',
    owner: {session: '合成会话'}, links: [{label: '看这镜', view: 'storyboard', projectId: p.id}], occurredAt: clock - 86_400_000, session: '合成跟进器', ...over});

  const A = notices.post(card('job-a')).notice;
  out.again = notices.post(card('job-a', {context: '再报一次'})).updated;
  out.duplicate = await code(() => lib.db.prepare('INSERT INTO notices(id,source,source_key,attempt,kind,status,data_json,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), 'synthetic-runner', 'job-a', 1, 'decision', 'open', '{}', 1, 1, 1)) === 'OK' ? 'accepted' : 'rejected';
  out.reserved = await code(() => notices.post(card('x', {source: 'project-music'})));
  clock += 1000;
  out.later = notices.decide(A.id, {action: 'later', expectedRevision: 2}).notice.status;
  out.stale = await code(() => notices.decide(A.id, {action: 'skip', expectedRevision: 2}));
  out.early = await code(() => notices.report(A.id, {state: 'running', session: '合成跟进器'}));
  out.redo = notices.decide(A.id, {action: 'redo', expectedRevision: 3, costAcknowledged: true}).notice.status;
  clock += 1000;
  const failed = notices.report(A.id, {state: 'failed', session: '合成跟进器', note: '又超时'});
  out.repeat = notices.report(A.id, {state: 'failed', session: '合成跟进器'}).next.id === failed.next.id;
  const B = notices.post(card('job-b', {kind: 'info', typeLabel: '生成完成', costNote: undefined})).notice;
  out.read = notices.decide(B.id, {action: 'read', expectedRevision: 1}).notice.status;
  notices.post(card('job-c'));
  notices.sync({force: true});
  // AI 补完项目音乐那一轮 → 卡片自动结束
  const r1 = music.song(p.id, song.id).rounds[0];
  music.agentNotes(p.id, r1.id, {expectedRevision: r1.revision, session: '合成会话', issues: {items: [{text: '问题', source: 'objective_check', causeGuess: ''}]}, nextDirection: {text: '方向'}});
  clock += 5000;
  notices.sync({force: true});
  const list = notices.list();
  out.summary = list.summary;
  out.endedTotal = list.endedTotal;
  // 同一时刻结束的卡按编号排，编号每次不同：按来源、原编号、第几次排好再比
  out.notices = list.notices.map(shape).sort((a, b) => (a.source + a.key + a.attempt).localeCompare(b.source + b.key + b.attempt));
  out.filtered = notices.list({source: 'synthetic-runner', status: 'open'}).notices.map(n => n.key);
  await music.close();
  return {out, lib};
}

const result = {sqlite: null, mysql: null, mysqlRun: false, version: null};
let server, connection, mysqlDb, sqliteLib, passed = false, logs = '';
try {
  const sqliteApp = path.join(base, 'sqlite-app');
  let storage = await new MysqlStorage(sqliteApp).init();
  sqliteLib = await new Library(sqliteApp, {directoryClassification: true}).init();
  storage.attach(sqliteLib);
  result.sqlite = (await scenario(sqliteLib, sqliteApp)).out;
  console.log('SQLite', JSON.stringify(result.sqlite));
  const binary = process.env.NOTICES_MYSQLD || process.env.PROJECT_MUSIC_MYSQLD;
  if (!binary) {
    console.log('MySQL 未运行：没有提供 NOTICES_MYSQLD。本次只验证了 SQLite 一半，不能写成「两库一致」。');
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
    // 和正式环境一样：先起一个全新的 SQLite 库，再切到 MySQL，然后跑同一场景。
    const appDir = path.join(base, 'mysql-app'); await fs.mkdir(appDir);
    let mysqlStorage = await new MysqlStorage(appDir).init();
    let mysqlLib = await new Library(appDir, {directoryClassification: true}).init();
    mysqlStorage.attach(mysqlLib);
    // #134 的合同：切库后要重启，旧进程里的 lib.db 还是 SQLite；照其他 MySQL 测试用 activateAndRestart。
    ({lib: mysqlLib, storage: mysqlStorage} = await activateAndRestart({storage: mysqlStorage, lib: mysqlLib, config: {...config, database: 'notices_check'}}));
    assert.equal(mysqlLib.db.kind, 'mysql');
    mysqlDb = mysqlLib.db;
    result.mysql = (await scenario(mysqlLib, appDir)).out;
    result.mysqlRun = true;
    console.log('MySQL ' + result.version, JSON.stringify(result.mysql));
    const [cols] = await connection.query("SELECT COLUMN_NAME c, COLUMN_TYPE ty FROM information_schema.COLUMNS WHERE TABLE_SCHEMA='notices_check' AND TABLE_NAME='notices'");
    result.mysqlColumns = cols.map(r => `${r.c}=${r.ty}`).sort();
    const [idx] = await connection.query("SELECT DISTINCT INDEX_NAME i, NON_UNIQUE u FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='notices_check' AND TABLE_NAME='notices'");
    result.mysqlIndexes = idx.map(r => `${r.i}:${r.u}`).sort();
    console.log(JSON.stringify({columns: result.mysqlColumns, indexes: result.mysqlIndexes}));
    assert.deepEqual(result.mysql, result.sqlite, 'SQLite 与 MySQL 的行为不一致');
    // 一次性迁移（server/mysql.mjs）：SQLite 里的待处理原样进 MySQL，读出来和迁移前一致。
    const before = new Notices({lib: sqliteLib}).init().list({endedLimit: 500});
    ({lib: sqliteLib, storage} = await activateAndRestart({storage, lib: sqliteLib, config: {...config, database: 'notices_migration'}}));
    assert.equal(sqliteLib.db.kind, 'mysql');
    const after = new Notices({lib: sqliteLib}).init().list({endedLimit: 500});
    assert.deepEqual(after.notices, before.notices, '迁移到 MySQL 后待处理数据不一致');
    const [uniq] = await connection.query("SELECT INDEX_NAME i FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='notices_migration' AND TABLE_NAME='notices' AND NON_UNIQUE=0 AND COLUMN_NAME='attempt'");
    assert.ok(uniq.length, '迁移后保留 (source, source_key, attempt) 唯一约束');
    const [mi] = await connection.query("SELECT DISTINCT INDEX_NAME i FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='notices_migration' AND TABLE_NAME='notices' AND INDEX_NAME='notices_status'");
    assert.ok(mi.length, '迁移后保留状态索引');
    result.migration = 'OK';
    assert.ok(result.mysqlColumns.includes('data_json=longtext'));
    assert.ok(result.mysqlColumns.includes('source_key=varchar(160)'));
  }
  const s = result.sqlite;
  assert.equal(s.again, true);
  assert.equal(s.duplicate, 'rejected', '同一个来源 + 原编号 + 第几次必须唯一');
  assert.equal(s.reserved, 'SOURCE_RESERVED');
  assert.deepEqual([s.later, s.stale, s.early, s.redo, s.repeat, s.read], ['later', 'REVISION_CONFLICT', 'NOT_REDO_DECIDED', 'redo_decided', true, 'read']);
  assert.deepEqual(s.summary, {pending: 2, info: 0, later: 0, inflight: 0, ended: 3});
  assert.deepEqual(s.filtered.sort(), ['job-a', 'job-c']);
  assert.ok(s.notices.some(n => n.source === 'project-music' && n.status === 'resolved' && n.resolution === '记录已经补完了'), JSON.stringify(s.notices));
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
