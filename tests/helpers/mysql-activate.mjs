// Disposable-test/QA callers only. Rebuild owners; never replace a live lib.db.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import mysql from 'mysql2/promise';
import {Library} from '../../server/library.mjs';
import {MysqlStorage} from '../../server/mysql.mjs';

async function bounded(promise, label, ms = 15000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(label)), ms); })]); }
  finally { clearTimeout(timer); }
}
export async function closeMysqlDatabase(db, inventory = []) {
  if (!db) return;
  if (db.kind !== 'mysql') { if (db.open) db.close(); return; }
  const record = {kind: 'mysql-worker', exited: false}; inventory.push(record);
  if (db.worker.threadId !== -1) {
    const exited = once(db.worker, 'exit'); db.close();
    record.exitCode = (await bounded(exited, 'MySQL worker exit unknown'))[0];
  }
  record.exited = db.worker.threadId === -1; assert.equal(record.exited, true);
}
export async function activateAndRestart({storage, lib, config, closeOwners = async () => {},
  openLibrary = (dataDir, database, options) => new Library(dataDir, {...options, database}).init(),
  rebuild = async () => ({})}) {
  const deadline = Date.now() + 10000;
  while (lib.workers || lib.metadataPending?.size || lib.metadataQueue?.length) {
    assert.ok(Date.now() < deadline, 'owned source metadata work not settled');
    await new Promise(r => setTimeout(r, 20));
  }
  const oldDb = lib.db, result = await storage.activate(config);
  assert.equal(result.restartRequired, true); assert.equal(result.mode, 'sqlite');
  assert.equal(lib.db, oldDb); assert.equal(oldDb.open, true);
  await closeOwners();
  oldDb.close(); assert.equal(oldDb.open, false);
  const freshStorage = await new MysqlStorage(storage.dataDir).init();
  assert.equal(freshStorage.database?.kind, 'mysql');
  try {
    const freshLib = await openLibrary(storage.dataDir, freshStorage.database, {directoryClassification: !!lib.directoryClassification});
    assert.notEqual(freshLib, lib); assert.equal(freshLib.db, freshStorage.database);
    freshStorage.attach(freshLib);
    const owners = await rebuild(freshLib, freshStorage);
    console.log('MYSQL_OWNER_RESTART_VERIFIED');
    return {lib: freshLib, storage: freshStorage, owners};
  } catch (error) { await closeMysqlDatabase(freshStorage.database); throw error; }
}

// Optional native alternative for old Docker-only QA callers. No existing server
// configuration is accepted; the binary must be selected explicitly by the tester.
export async function startOwnedNativeMysql(binary) {
  assert.ok(path.isAbsolute(binary), 'explicit absolute native mysqld required');
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sg-owned-mysql82-')));
  const data = path.join(directory, 'mysql'); await fs.mkdir(data, {mode: 0o700});
  const inventory = {directory, workers: [], databases: [], cleanup: 'NOT_STARTED'};
  const capture = (args, name) => {
    const child = spawn(binary, args, {stdio: ['ignore', 'pipe', 'pipe']});
    child.log = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { child.log += b; });
    child.ended = once(child, 'exit'); child.logName = name; return child;
  };
  const init = capture(['--no-defaults', '--initialize-insecure', '--datadir=' + data], 'init');
  assert.equal((await bounded(init.ended, 'owned MySQL init unknown', 60000))[0], 0, init.log);
  const listener = net.createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port; await new Promise(r => listener.close(r));
  assert.notEqual(port, 3306); assert.notEqual(port, 4317);
  const daemon = capture(['--no-defaults', '--datadir=' + data, '--port=' + port, '--bind-address=127.0.0.1',
    '--socket=' + path.join(directory, 'mysql.sock'), '--pid-file=' + path.join(directory, 'mysql.pid'), '--mysqlx=OFF'], 'daemon');
  const config = {host: '127.0.0.1', port, user: 'root', password: '', connectTimeout: 1000};
  let control;
  try {
    for (let n = 0; n < 200 && !control; n++) {
      try { control = await mysql.createConnection(config); }
      catch { assert.equal(daemon.exitCode, null, daemon.log); await new Promise(r => setTimeout(r, 100)); }
    }
    assert.ok(control, 'owned native MySQL readiness unknown');
    const [[identity]] = await control.query('SELECT VERSION() version,@@port port,@@datadir datadir');
    assert.match(identity.version, /^8\.2\./); assert.equal(identity.port, port);
    assert.equal(await fs.realpath(identity.datadir), data);
    inventory.server = identity; inventory.pid = daemon.pid;
  } catch (error) {
    await control?.end(); daemon.kill('SIGTERM'); await bounded(daemon.ended, 'owned native setup shutdown unknown');
    await fs.writeFile(path.join(directory, 'mysql.log'), daemon.log); throw error;
  }
  const allowed = new Set();
  return {directory, inventory, config: database => ({...config, database}),
    async schema(label) {
      assert.match(label, /^[a-z_]{1,20}$/);
      const name = 'owned_' + label + '_' + randomUUID().replaceAll('-', '').slice(0, 12);
      await control.query('CREATE DATABASE `' + name + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
      allowed.add(name); inventory.databases.push(name); return name;
    },
    async connection(database) { assert.ok(allowed.has(database)); return mysql.createConnection({...config, database}); },
    async closeDb(db) { return closeMysqlDatabase(db, inventory.workers); },
    async finish() {
      assert.ok(inventory.workers.every(w => w.exited), 'owned worker still unsettled');
      await control.end(); daemon.kill('SIGTERM');
      assert.equal((await bounded(daemon.ended, 'owned mysqld exit unknown'))[0], 0);
      inventory.cleanup = 'OWN_MYSQL_STOPPED_TEMP_RETAINED';
      await fs.writeFile(path.join(directory, 'mysql.log'), daemon.log);
      await fs.writeFile(path.join(directory, 'inventory.json'), JSON.stringify(inventory, null, 2));
    },
  };
}
