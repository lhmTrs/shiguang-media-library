import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import Database from 'better-sqlite3';
import { Library } from '../server/library.mjs';
import { MysqlStorage } from '../server/mysql.mjs';
import { MysqlDatabase } from '../server/mysql-db.mjs';
import { Projects } from '../server/projects.mjs';
import { ProjectAssets } from '../server/project-assets/store.mjs';
import { addLook, addImage } from './helpers/creative-fixture.mjs';
import { assertCharacterMergeRequestRace } from './helpers/character-merge-request-race.mjs';

const evidence = path.resolve(process.env.CREATIVE_MYSQL_EVIDENCE || 'collab/results/PROJECT-ASSET-LIBRARY-20261104/mysql'); await fs.mkdir(evidence, { recursive: true });
const base = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-mysql-')), data = path.join(base, 'mysql'); await fs.mkdir(data, { mode: 0o700 });
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r));
const config = { host: '127.0.0.1', port, user: 'root', password: '', database: 'creative_migration' };
let server, connection, lib, storage, freshDB, returnedDB, logs = '', version, passed = false, workersKnown = false; const checks = [];
async function bounded(p, ms, label) { let timer; try { return await Promise.race([p, new Promise((_, reject) => timer = setTimeout(() => reject(Error(label)), ms))]); } finally { clearTimeout(timer); } }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
process.env.MEDIA_SKIP_IMPORT = '1'; process.env.MEDIA_SKIP_RECONCILE = '1'; process.env.MEDIA_NO_WATCH = '1'; process.env.MEDIA_READONLY_FILES = '1'; process.env.SHIGUANG_AUDIO_ANALYSIS = '0';
async function lifecycle(store, projects, media) {
 const suffix = randomUUID().slice(0, 8), p = projects.save(null, { name: 'MySQL合成甲' + suffix }), target = projects.save(null, { name: 'MySQL合成乙' + suffix });
 let a = await store.create({ project_id: p.id, kind: 'character', name: '陈川' }); a.base_info = '长文本\n'.repeat(2000); addLook(a); addImage(a, media); a = await store.save(a.id, a, a.revision);
 await assert.rejects(store.create({ project_id: p.id, kind: 'character', name: ' 陈川 ' }), e => e.status === 409); await assert.rejects(store.save(a.id, a, 1), e => e.status === 409);
 const preview = store.copyPreview(a.id, target.id), input = { request_id: preview.request_id, source_revision: a.revision, project_id: target.id, name: '副本' };
 const copy = store.copy(a.id, input); assert.equal(store.copy(a.id, input).id, copy.id); assert.equal(copy.images[0].media_asset_id, media); assert.notEqual(copy.images[0].id, a.images[0].id); assert.equal(copy.looks[0].default_image_id, copy.images[0].id);
 const before = a.name; a.name = '改名'; a = await store.save(a.id, a, a.revision); assert.equal(store.get(copy.id).source.asset_name, before); assert.throws(() => projects.remove(p.id), /创作资产/);
 for (const kind of ['scene','prop']) { let item = await store.create({ project_id: p.id, kind, name: '独立资料' }); addImage(item, media); item = await store.save(item.id, item, item.revision); assert.ok(item.default_image_id); store.archive(item.id, true, item.revision); }
 return a;
}
try {
 const binary = process.env.CREATIVE_MYSQLD || '/usr/local/mysql/bin/mysqld';
 const init = spawn(binary, ['--no-defaults', '--initialize-insecure', '--datadir=' + data], { stdio: ['ignore','pipe','pipe'] }); init.stdout.on('data', b => logs += b); init.stderr.on('data', b => logs += b); assert.equal((await bounded(once(init, 'exit'), 30000, 'MySQL init timed out'))[0], 0);
 server = spawn(binary, ['--no-defaults', '--datadir=' + data, '--port=' + port, '--bind-address=127.0.0.1', '--socket=' + path.join(base, 'mysql.sock'), '--pid-file=' + path.join(base, 'mysql.pid'), '--mysqlx=OFF'], { stdio: ['ignore','pipe','pipe'] }); server.stdout.on('data', b => logs += b); server.stderr.on('data', b => logs += b);
 for (let i = 0; i < 100; i++) { try { connection = await mysql.createConnection({ ...config, database: undefined, connectTimeout: 500 }); break; } catch { if (server.exitCode !== null) throw Error('Owned mysqld exited'); await new Promise(r => setTimeout(r, 150)); } }
 assert.ok(connection); version = (await connection.query('SELECT VERSION() version'))[0][0].version; assert.match(version, /^8\.2\./); console.log('MySQL ' + version);
 const appDir = path.join(base, 'app'); storage = await new MysqlStorage(appDir).init(); lib = await new Library(appDir, { directoryClassification: true }).init(); storage.attach(lib);
 const projects = new Projects(lib).init(), store = new ProjectAssets(lib).init(), photoDir = path.join(base, 'photos'); await fs.mkdir(photoDir);
 await fs.writeFile(path.join(photoDir, 'synthetic.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64'));
 const root = await lib.addRoot(photoDir, 'photo'); const job = lib.scan(root.id); for (let i = 0; i < 100 && job.status === 'running'; i++) await new Promise(r => setTimeout(r, 30)); assert.equal(job.status, 'done');
 const media = lib.db.prepare('SELECT id FROM assets LIMIT 1').get().id;
 await lifecycle(store, projects, media); const before = store.snapshot(), projectBefore = store.scopes();
 await check('实际 SQLite→MySQL 迁移保留六表、项目身份、版本、默认项及时间', async () => { await storage.activate(config); assert.equal(lib.db.kind, 'mysql'); assert.deepEqual(store.snapshot(), before); assert.deepEqual(store.scopes().items, projectBefore.items); });
 await check('迁移后的当前 MySQL 实际人物/场景/道具、复制和版本冲突闭环', async () => { projects.init(); store.init(); await lifecycle(store, projects, media); });
 const snapshot = store.backup();
 await check('MySQL 数据库唯一约束与失败事务回滚', async () => {
  const a = store.get(snapshot.tables.creative_assets[0].id); const checksum = store.backup().checksum;
  lib.db.exec("CREATE TRIGGER refuse_creative_version BEFORE INSERT ON creative_asset_versions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic rollback'");
  await assert.rejects(store.save(a.id, { ...a, name: '不得保存' }, a.revision), /synthetic rollback/); assert.equal(store.backup().checksum, checksum); lib.db.exec('DROP TRIGGER refuse_creative_version');
  const row = snapshot.tables.creative_assets[0]; assert.throws(() => lib.db.prepare('INSERT INTO creative_assets SELECT ?,project_id,kind,name,name_key,data_json,default_look_id,default_image_id,revision,archived_at,source_json,created_at,updated_at,owner_type,owner_id FROM creative_assets WHERE id=?').run(randomUUID(), row.id), e => e.code === 'ER_DUP_ENTRY');
 });
 await connection.query('CREATE DATABASE creative_fresh CHARACTER SET utf8mb4 COLLATE utf8mb4_bin'); freshDB = new MysqlDatabase({ ...config, database: 'creative_fresh' });
 const freshLib = { db: freshDB, dataDir: path.join(base, 'fresh'), asset: lib.asset.bind(lib), checked: lib.checked.bind(lib) }; const freshProjects = new Projects(freshLib).init(), fresh = new ProjectAssets(freshLib).init();
 await check('原生 MySQL 建表及内部备份恢复保留所有版本和来源', async () => { await fresh.restore(snapshot); assert.deepEqual(fresh.snapshot(), store.snapshot()); fresh.init(); assert.equal(fresh.scopes().items.filter(p => p.project_kind === 'public').length, 1); });
 await check('MySQL→SQLite 逻辑恢复完整，素材文件缺席明确失效', async () => {
  const targetDir = path.join(base, 'return'); await fs.mkdir(targetDir); returnedDB = new Database(path.join(targetDir, 'library.sqlite')); const targetLib = { db: returnedDB, dataDir: targetDir, asset: () => { throw Error('missing'); } }; new Projects(targetLib).init(); const returned = new ProjectAssets(targetLib).init(); await returned.restore(fresh.backup()); assert.deepEqual(returned.snapshot(), fresh.snapshot()); const a = returned.snapshot().creative_assets.find(a => returned.get(a.id).images.length); assert.equal((await returned.health(a.id)).images[0].state, 'missing');
 });
 await check('原生旧项目表升级先备份；公共项目和名称规则保持', async () => {
  freshDB.exec('ALTER TABLE media_projects DROP INDEX media_projects_system_key'); freshDB.exec('ALTER TABLE media_projects DROP COLUMN system_key'); freshDB.exec('ALTER TABLE media_projects DROP COLUMN project_kind');
  // Deliberate old-schema fixture, retaining ordinary records; verify additive upgrade and backup without reinitializing a new public project.
  freshProjects.init(); assert.ok((await fs.readdir(path.join(freshLib.dataDir, 'backups'))).some(n => n.startsWith('projects-before-creative-'))); assert.ok(freshProjects.list().length > 0);
 });
 await check('原生 MySQL 旧资产 v2 升级保留已有编号、历史和图片引用', () => {
  const before = fresh.snapshot();
  freshDB.exec('ALTER TABLE creative_assets DROP INDEX creative_assets_name_owner, DROP COLUMN owner_type, DROP COLUMN owner_id, MODIFY project_id VARCHAR(36) NOT NULL');
  freshDB.exec('CREATE UNIQUE INDEX creative_assets_name_archive ON creative_assets(project_id,kind,name_key,archived_at)');
  freshDB.prepare('UPDATE creative_schema SET version=2 WHERE id=?').run('asset-library');
  fresh.init();
  const after = fresh.snapshot();
  assert.deepEqual(after.creative_assets, before.creative_assets);
  assert.deepEqual(after.creative_image_bindings, before.creative_image_bindings);
  assert.deepEqual(after.creative_asset_versions, before.creative_asset_versions);
  assert.equal(after.creative_schema[0].version,3);
 });
 await check('原生 MySQL P2a 同剧覆盖、提升、归档、回执及独立备份恢复', async () => {
  const request_id = () => randomUUID(), dir = freshProjects.series;
  const series = dir.createSeries({ name: 'P2a 合成剧', request_id: request_id() });
  const season = dir.createSeason(series.id, { request_id: request_id() });
  const { project: episode } = dir.createEpisode(series.id, {
   season_id: season.id, expected_episode_no: 1, request_id: request_id(),
  });
  const scope = fresh.scoped.scope('episode', episode.id), write = fresh.scopedWrites;
  const draft = await fresh.create({ project_id: episode.id, kind: 'character', name: 'P2a 合成人物' });
  const first = addLook(draft, '日常'), second = addLook(draft, '夜间');
  await fresh.save(draft.id, draft, draft.revision);
  const plan = fresh.scopedImpact.previewPromotion('episode', episode.id, draft.id, { context_token: scope.context_token });
  const promoted = fresh.scopedImpact.commitPromotion('episode', episode.id, draft.id, {
   request_id: request_id(), context_token: scope.context_token, preview_token: plan.preview_token,
  });
  assert.equal(promoted.owner.id,series.id);
  const seasonItem = fresh.scoped.detail('season', season.id, draft.id);
  write.setOverride('season', season.id, draft.id, {
   request_id: request_id(), context_token: seasonItem.context_token, write_token: seasonItem.effective.default_look.write_token,
   field: { key: 'default_look' }, action: 'set', value: second.id,
  });
  assert.equal(fresh.scoped.detail('episode', episode.id, draft.id).effective.default_look.value,second.id);
  const { context_token } = fresh.scoped.scope('series', series.id);
  const archive = fresh.scopedImpact.previewArchive('series', series.id, draft.id, {
   context_token, target: { type: 'look', id: second.id },
  });
  const archived = fresh.scopedImpact.commitArchive('series', series.id, draft.id, {
   request_id: request_id(), context_token, preview_token: archive.preview_token,
  });
  assert.equal(fresh.scoped.detail('episode', episode.id, draft.id).effective.default_look.value,first.id);
  assert.deepEqual(write.request(archived.request_id).result,archived);
  const backup = fresh.backup();
  const restoreDir = path.join(base, 'p2a-restored'); await fs.mkdir(restoreDir);
  const restoredDB = new Database(path.join(restoreDir, 'library.sqlite'));
  try {
   const restoredLib = { db: restoredDB, dataDir: restoreDir };
   new Projects(restoredLib).init();
   const restored = new ProjectAssets(restoredLib).init();
   await restored.restore(backup);
   assert.deepEqual(restored.snapshot(),fresh.snapshot());
   assert.equal(restored.scoped.detail('episode', episode.id, draft.id).effective.default_look.value,first.id);
  } finally { restoredDB.close(); }
 });
 await check('原生 MySQL 合并同名人物、回执幂等、旧身份解析、备份及撤销', async () => {
  const directory = freshProjects.series, svc = fresh.characterMerges;
  const drama = directory.createSeries({ request_id:randomUUID(), name:'MySQL 合成同名剧' });
  const episode = n => directory.createEpisode(drama.id, {
   request_id:randomUUID(), season_id:null, expected_episode_no:n,
  }).project;
  const a = episode(1), b = episode(2);
  const first = await fresh.create({project_id:a.id, kind:'character', name:'同一人物'});
  const second = await fresh.create({project_id:b.id, kind:'character', name:'同一人物'});
  const groups = svc.groups(drama.id), context_token = groups.context_token;
  const preview = svc.preview(drama.id, {context_token, group_id:groups.items[0].group_id, primary_asset_id:first.id});
  const input = {context_token, request_id:randomUUID(), preview_token:preview.preview_token, choices:preview.choices};
  freshLib.migrating = true;
  assert.throws(() => svc.confirm(drama.id, input), error => error.status === 423 && !error.details?.request_settled);
  freshLib.migrating = false;
  assert.deepEqual(svc.request(drama.id, input.request_id), {found:false});
  const merged = svc.confirm(drama.id, input);
  assert.deepEqual(svc.confirm(drama.id, input), merged);
  assert.equal(svc.resolveAsset(b.id, second.id), first.id);
  assert.equal(fresh.validateBackup(fresh.backup()).tables.creative_character_aliases.length, 1);
  const undo = svc.undoPreview(drama.id, merged.merge_id, {context_token});
  assert.equal(undo.status, 'clean');
  const result = svc.undo(drama.id, merged.merge_id, {context_token, request_id:randomUUID(),
   undo_token:undo.undo_token, accept_restore_changes:false});
  assert.equal(result.status, 'undone');
  assert.equal(fresh.get(first.id).project_id, a.id);
  assert.equal(fresh.get(second.id).archived_at, 0);
  assert.equal(fresh.validateBackup(fresh.backup()).tables.creative_character_aliases.length, 0);
  const legacy = fresh.backup();
  const rejectedInput = { ...input, request_id:randomUUID() };
  const rejection = {status:409, code:'CHARACTER_MERGE_STALE', details:{request_settled:true}};
  assert.throws(() => svc.confirm(drama.id, rejectedInput), rejection);
  const mixed = fresh.backup();
  for (const [name, backup] of [['receipt_legacy', legacy], ['receipt_mixed', mixed]]) {
   await connection.query('CREATE DATABASE ' + name + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
   const db = new MysqlDatabase({ ...config, database:name });
   const done = once(db.worker, 'exit');
   try {
    const targetLib = { db, dataDir:path.join(base, name) };
    new Projects(targetLib).init();
    const target = new ProjectAssets(targetLib).init();
    await target.restore(backup);
    const receipt = target.characterMerges;
    assert.deepEqual(receipt.request(drama.id, input.request_id).result, {...merged, can_undo:false});
    assert.deepEqual(receipt.request(drama.id, result.request_id).result, result);
    if (backup === mixed) {
     assert.deepEqual(receipt.request(drama.id, rejectedInput.request_id), svc.request(drama.id, rejectedInput.request_id));
     assert.throws(() => receipt.confirm(drama.id, rejectedInput), rejection);
    } else assert.deepEqual(receipt.request(drama.id, rejectedInput.request_id), {found:false});
   } finally {
    db.close();
    await bounded(done, 10000, 'Receipt restore worker exit unknown');
   }
  }
 });
 await check('双 MySQL 连接按先提交的成功或拒绝回执结清同一编号', async () => {
  const options = { mysql:{ ...config, database:'creative_fresh' } };
  await assertCharacterMergeRequestRace(fresh, options, false);
  await assertCharacterMergeRequestRace(fresh, options, true);
 });
 passed = true;
} catch (e) { await fs.writeFile(path.join(evidence, 'failure.txt'), e.stack); throw e; }
finally {
 returnedDB?.close(); const workers = [];
 for (const db of [freshDB, lib?.db]) if (db?.kind === 'mysql') { const done = db.worker.threadId === -1 ? Promise.resolve() : once(db.worker, 'exit'); db.close(); workers.push(done); } else if (db?.open) db.close();
 await bounded(Promise.all(workers), 10000, 'MySQL worker exit unknown'); workersKnown = true; await connection?.end();
 if (server && server.exitCode === null) { const done = once(server, 'exit'); server.kill('SIGTERM'); await bounded(done, 15000, 'Owned mysqld exit unknown'); }
 const mysqlKnown = !server || server.exitCode !== null || server.signalCode !== null; await fs.writeFile(path.join(evidence, 'mysql.log'), logs);
 await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify({ passed, version, checks, resources: { workersKnown, mysqlKnown, tempRemoved: passed && mysqlKnown, ...(!passed ? { retained: base } : {}) }, scope: 'Fresh --no-defaults isolated MySQL and synthetic library only; author service/credentials/data untouched.' }, null, 2));
 if (passed && mysqlKnown) await fs.rm(base, { recursive: true, force: true });
}
