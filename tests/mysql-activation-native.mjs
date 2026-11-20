// Explicit native integration test. Never connects to an existing MySQL server.
// MYSQL_ACTIVATION_MYSQLD=/path/to/mysqld node tests/mysql-activation-native.mjs
// MYSQL_ACTIVATION_BASELINE=1 records the old HTTP failure without changing code.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import mysql from 'mysql2/promise';
import Sqlite from 'better-sqlite3';

const binary = process.env.MYSQL_ACTIVATION_MYSQLD;
assert.ok(binary && path.isAbsolute(binary), 'explicit absolute MYSQL_ACTIVATION_MYSQLD required');
const repo = fileURLToPath(new URL('../', import.meta.url));
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sg-mysql-activation-')));
const baseline = process.env.MYSQL_ACTIVATION_BASELINE === '1';
const inventory = {root, baseline, checks: [], processes: [], cleanup: 'NOT_STARTED'};
const apps = new Set();
const exec = promisify(execFile);
let daemon, control;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function bounded(p, ms, label) {
  let timer;
  try { return await Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), ms); })]); }
  finally { clearTimeout(timer); }
}
async function port() {
  const s = net.createServer();
  await new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', resolve); });
  const value = s.address().port;
  await new Promise(resolve => s.close(resolve));
  assert.notEqual(value, 4317); assert.notEqual(value, 3306);
  return value;
}
function child(command, args, label, env) {
  const p = spawn(command, args, {cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe']});
  const record = {label, pid: p.pid, exited: false}; inventory.processes.push(record);
  const capture = b => { p.log += b; appendFileSync(path.join(root, label + '.log'), b, {mode: 0o600}); };
  p.log = ''; p.stdout.on('data', capture); p.stderr.on('data', capture);
  p.ended = once(p, 'exit').then(([code, signal]) => { Object.assign(record, {exited: true, code, signal}); return code; });
  return p;
}
async function stop(p, label, known = false) {
  if (!p) return;
  if (p.exitCode === null && p.signalCode === null) p.kill('SIGTERM');
  assert.equal(await bounded(p.ended, 20000, label + ' exit unknown; retained'), 0, p.log);
  if (known) assert.match(p.log, /APPLICATION_CLOSED_KNOWN/);
  await fs.writeFile(path.join(root, label + '.log'), p.log);
}
async function boot(dataDir, label) {
  await fs.mkdir(dataDir, {recursive: true, mode: 0o700});
  const p = child(process.execPath, ['server/index.mjs'], label, {
    ...process.env, MEDIA_DATA_DIR: dataDir, MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1',
    MEDIA_PERSONAL_ITEM_DIR: path.join(dataDir, 'personal-items'),
    MEDIA_NO_WATCH: '1', MEDIA_CODEX_AUTOCONNECT: '0', SHIGUANG_AUDIO_ANALYSIS: '0',
    // Existing desktop-unavailable gate avoids unrelated lazy Swift compilers.
    CONTAINER: '1', NODE_ENV: 'production', PORT: String(await port()),
  });
  apps.add(p);
  let origin;
  for (let i = 0; i < 600; i++) {
    const match = p.log.match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) { origin = match[0]; break; }
    if (p.exitCode !== null) throw Error('app startup failed: ' + p.log);
    await sleep(100);
  }
  assert.ok(origin, 'app readiness unknown: ' + p.log);
  assert.notEqual(new URL(origin).port, '4317');
  const session = await fetch(origin + '/api/session');
  assert.equal(session.status, 200);
  const {token} = await session.json(), cookie = session.headers.get('set-cookie').split(';')[0];
  return {p, dataDir, async api(route, method = 'GET', body) {
    const response = await fetch(origin + route, {method, signal: AbortSignal.timeout(60000), headers: {
      cookie, origin, 'x-local-token': token, 'content-type': 'application/json',
    }, body: body === undefined ? undefined : JSON.stringify(body)});
    return {status: response.status, body: await response.json()};
  }, async close() { await stop(p, label, true); apps.delete(p); }};
}
async function seed(app) {
  const project = await app.api('/api/projects', 'POST', {name: 'Synthetic migration project', note: 'owned fixture'});
  assert.equal(project.status, 200);
  const route = '/api/project-assets/projects/' + project.body.id + '/script';
  const script = await app.api(route, 'PUT', {expected_revision: 0, title: '合成剧本', content: '第一行\n第二行，emoji 🎬'});
  assert.equal(script.status, 200);
  assert.equal(typeof script.body.revision, 'number'); assert.equal(typeof script.body.updated_at, 'number');
  return {route, script: script.body, project: project.body};
}
async function absentConfig(app) {
  await assert.rejects(fs.access(path.join(app.dataDir, 'mysql-connection.json')), {code: 'ENOENT'});
  const state = await app.api('/api/mysql'); assert.equal(state.body.mode, 'sqlite'); assert.equal(state.body.migrating, false);
}
async function check(label, fn) { await fn(); inventory.checks.push(label); console.log('PASS ' + label); }

try {
  const data = path.join(root, 'mysql'); await fs.mkdir(data, {mode: 0o700});
  const init = child(binary, ['--no-defaults', '--initialize-insecure', '--datadir=' + data], 'mysql-init');
  assert.equal(await bounded(init.ended, 60000, 'mysql initialization unknown'), 0, init.log);
  const mysqlPort = await port(); inventory.mysqlPort = mysqlPort;
  daemon = child(binary, ['--no-defaults', '--datadir=' + data, '--port=' + mysqlPort, '--bind-address=127.0.0.1',
    '--socket=' + path.join(root, 'mysql.sock'), '--pid-file=' + path.join(root, 'mysql.pid'), '--mysqlx=OFF',
    '--general-log=ON', '--general-log-file=' + path.join(root, 'queries.log')], 'mysqld');
  const config = {host: '127.0.0.1', port: mysqlPort, user: 'root', password: ''};
  for (let i = 0; i < 200 && !control; i++) {
    try { control = await mysql.createConnection({...config, connectTimeout: 500}); }
    catch { assert.equal(daemon.exitCode, null, daemon.log); await sleep(150); }
  }
  assert.ok(control, 'owned MySQL readiness unknown');
  inventory.mysqlVersion = (await control.query('SELECT VERSION() v'))[0][0].v;
  assert.match(inventory.mysqlVersion, /^8\./);
  const app = await boot(path.join(root, 'populated'), 'populated');
  const fixture = await seed(app);
  const cfg = {...config, database: 'activation_populated'};
  await check('real HTTP connection test succeeds', async () => assert.deepEqual(await app.api('/api/mysql/test', 'POST', cfg), {status: 200, body: {connected: true}}));
  const activation = await app.api('/api/mysql/config', 'POST', cfg);
  if (baseline) {
    assert.equal(activation.status, 400); assert.match(activation.body.error, /MySQL 操作失败/);
    const log = await fs.readFile(path.join(root, 'queries.log'), 'utf8');
    assert.match(log, /CREATE TABLE IF NOT EXISTS project_scripts .*PRIMARY KEY NULL/);
    await absentConfig(app);
    assert.deepEqual((await app.api(fixture.route)).body, fixture.script);
    inventory.baselineHttp = activation;
    inventory.baselineDdl = log.split('\n').find(line => /CREATE TABLE IF NOT EXISTS project_scripts /.test(line));
    await control.query('USE activation_populated');
    await assert.rejects(control.query(inventory.baselineDdl.split('Query\t')[1]), {code: 'ER_PRIMARY_CANT_HAVE_NULL'});
    inventory.baselineMysqlError = 'ER_PRIMARY_CANT_HAVE_NULL';
    await check('baseline HTTP activate fails with project_scripts PRIMARY KEY NULL; SQLite retained', async () => {});
  } else {
    assert.equal(activation.status, 200, JSON.stringify(activation));
    assert.equal(activation.body.mode, 'mysql');
    await check('populated HTTP activate preserves complete script JSON and numeric timestamps', async () => assert.deepEqual((await app.api(fixture.route)).body, fixture.script));
    const [cols] = await control.execute("SELECT COLUMN_NAME name,IS_NULLABLE nullable,COLUMN_KEY colkey,DATA_TYPE datatype FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='project_scripts'", [cfg.database]);
    await check('migrated script PK, NOT NULL and BIGINT types survive', async () => {
      assert.deepEqual(cols.find(c => c.name === 'id'), {name: 'id', nullable: 'NO', colkey: 'PRI', datatype: 'varchar'});
      for (const name of ['revision', 'created_at', 'updated_at']) assert.deepEqual(cols.find(c => c.name === name), {name, nullable: 'NO', colkey: '', datatype: 'bigint'});
      assert.ok(cols.every(c => c.nullable === 'NO'));
      await assert.rejects(control.query('INSERT INTO activation_populated.project_scripts SELECT * FROM activation_populated.project_scripts'), {code: 'ER_DUP_ENTRY'});
      await assert.rejects(control.query("INSERT INTO activation_populated.project_scripts VALUES(NULL,'x','x',1,1,1)"), {code: 'ER_BAD_NULL_ERROR'});
      await assert.rejects(control.query("INSERT INTO activation_populated.project_scripts VALUES('owned-invalid',NULL,'x',1,1,1)"), {code: 'ER_BAD_NULL_ERROR'});
    });
    await check('nullable non-PK and project name uniqueness remain intact', async () => {
      const [columns] = await control.query("SHOW COLUMNS FROM activation_populated.media_projects LIKE 'system_key'");
      assert.equal(columns[0].Null, 'YES');
      await assert.rejects(control.query("INSERT INTO activation_populated.media_projects SELECT 'owned-duplicate',name,software,note,created_at,updated_at,project_kind,system_key FROM activation_populated.media_projects WHERE id=?", [fixture.project.id]), {code: 'ER_DUP_ENTRY'});
    });
    await app.close();
    const restarted = await boot(app.dataDir, 'restarted');
    await check('native MySQL restart preserves script JSON and permits revision update', async () => {
      assert.equal((await restarted.api('/api/mysql')).body.mode, 'mysql');
      assert.deepEqual((await restarted.api(fixture.route)).body, fixture.script);
      const changed = await restarted.api(fixture.route, 'PUT', {expected_revision: 1, title: '改后', content: '仍为合成数据'});
      assert.equal(changed.status, 200); assert.equal(changed.body.revision, 2); assert.equal(typeof changed.body.updated_at, 'number');
      assert.equal((await restarted.api(fixture.route, 'PUT', {expected_revision: 1, title: '旧', content: ''})).status, 409);
    });
    await restarted.close();
    const empty = await boot(path.join(root, 'empty'), 'empty');
    await check('fresh empty SQLite with project_scripts activates over real HTTP', async () => {
      const result = await empty.api('/api/mysql/config', 'POST', {...config, database: 'activation_empty'});
      assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.body.counts.project_scripts, 0);
    });
    await empty.close();
    const fail = await boot(path.join(root, 'rollback'), 'rollback'), source = await seed(fail);
    const sourceId = (await fs.readFile(path.join(fail.dataDir, 'mysql-source-id'), 'utf8')).trim();
    await control.query('CREATE DATABASE activation_rollback CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
    await control.query('CREATE TABLE activation_rollback.shiguang_database_meta(id INT PRIMARY KEY,source_id VARCHAR(36) NOT NULL,schema_version INT NOT NULL) ENGINE=InnoDB');
    await control.execute('INSERT INTO activation_rollback.shiguang_database_meta VALUES(1,?,1)', [sourceId]);
    await control.query('CREATE TABLE activation_rollback.project_scripts(id VARCHAR(36) PRIMARY KEY,title LONGTEXT NOT NULL,content LONGTEXT NOT NULL,revision BIGINT NOT NULL,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL) ENGINE=InnoDB');
    await control.query("CREATE TRIGGER activation_rollback.owned_fault BEFORE INSERT ON activation_rollback.project_scripts FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic private detail not for HTTP'");
    await check('copy failure rolls back earlier rows, keeps SQLite writable and configuration absent', async () => {
      const result = await fail.api('/api/mysql/config', 'POST', {...config, database: 'activation_rollback'});
      assert.equal(result.status, 400); assert.ok(!JSON.stringify(result).includes('synthetic private detail'));
      assert.match(result.body.error, /project_scripts/);
      await absentConfig(fail);
      assert.deepEqual((await fail.api(source.route)).body, source.script);
      assert.equal((await control.query('SELECT COUNT(*) n FROM activation_rollback.media_projects'))[0][0].n, 0);
      assert.equal((await control.query('SELECT COUNT(*) n FROM activation_rollback.project_scripts'))[0][0].n, 0);
      const updated = await fail.api(source.route, 'PUT', {expected_revision: 1, title: '回滚后仍可写', content: '保留'});
      assert.equal(updated.status, 200); source.script = updated.body;
    });
    await control.query('DROP TRIGGER activation_rollback.owned_fault');
    await check('same owned target retries after rollback without deleting scripts', async () => {
      assert.equal((await fail.api('/api/mysql/config', 'POST', {...config, database: 'activation_rollback'})).status, 200);
      assert.deepEqual((await fail.api(source.route)).body, source.script);
    });
    await fail.close();
    const invalidDir = path.join(root, 'invalid'), invalid = await boot(invalidDir, 'invalid-seed');
    const invalidFixture = await seed(invalid); await invalid.close();
    const sqlite = new Sqlite(path.join(invalidDir, 'library.sqlite'));
    sqlite.prepare("INSERT INTO project_scripts VALUES(NULL,'invalid legacy row','retained',1,1,1)").run(); sqlite.close();
    const legacy = await boot(invalidDir, 'invalid-legacy');
    await check('legacy NULL PK data fails safely without inventing IDs or discarding source rows', async () => {
      const result = await legacy.api('/api/mysql/config', 'POST', {...config, database: 'activation_invalid'});
      assert.equal(result.status, 400); assert.match(result.body.error, /project_scripts/); await absentConfig(legacy);
      assert.deepEqual((await legacy.api(invalidFixture.route)).body, invalidFixture.script);
      const db = new Sqlite(path.join(invalidDir, 'library.sqlite'), {readonly: true});
      try { assert.equal(db.prepare('SELECT COUNT(*) n FROM project_scripts').get().n, 2); assert.equal(db.prepare('SELECT COUNT(*) n FROM project_scripts WHERE id IS NULL').get().n, 1); }
      finally { db.close(); }
    });
    await legacy.close();
  }
  inventory.result = 'PASS';
} finally {
  const errors = [];
  for (const app of apps) try { await stop(app, 'remaining-' + app.pid, true); } catch (e) { errors.push(e.message); }
  try { await control?.end(); } catch (e) { errors.push(e.message); }
  try { await stop(daemon, 'mysqld'); } catch (e) { errors.push(e.message); }
  try {
    const {stdout} = await exec('/bin/ps', ['-axo', 'pid=,ppid=,command=']);
    inventory.remainingOwnedProcesses = stdout.split('\n').filter(line => line.includes(root));
    assert.deepEqual(inventory.remainingOwnedProcesses, [], 'owned descendants remain');
  } catch (e) { errors.push(e.message); }
  inventory.cleanup = errors.length ? 'UNKNOWN_RETAINED' : 'OWN_PROCESSES_CLOSED_TEMP_RETAINED'; inventory.cleanupErrors = errors;
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(inventory, null, 2));
  console.log(JSON.stringify(inventory, null, 2));
  assert.deepEqual(errors, [], 'owned process cleanup incomplete');
}
