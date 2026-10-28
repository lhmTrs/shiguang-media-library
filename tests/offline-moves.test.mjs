import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Library } from '../server/library.mjs';
import { MissingFiles } from '../server/missing-files.mjs';
import { reconcileRoot, reconcilePaths } from '../server/reconcile.mjs';
import { readManifest } from '../server/fs-manifest.mjs';

const options = { tagFiles: false, hashBudgetFiles: 0, hashBudgetBytes: 0 };
async function setup(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sg-offline-move-')));
  console.log(JSON.stringify({ registeredRoot: base, policy: 'RETAIN_ALL', setup: true }));
  const lib = await new Library(path.join(base, 'data'), { directoryClassification: true }).init();
  lib.enqueue = () => {};
  const roots = [];
  for (const name of ['source', 'target']) {
    const dir = path.join(base, name); await fs.mkdir(dir);
    roots.push(await lib.addRoot(dir, 'music'));
  }
  const source = path.join(roots[0].path, 'song.wav');
  await fs.writeFile(source, 'original audio fixture');
  await reconcileRoot(lib, roots[0], options);
  const asset = lib.list().items[0];
  lib.patch(asset.id, { tags: ['keep'], note: 'original note', favorite: true });
  await reconcileRoot(lib, roots[0], options);
  t.after(() => { lib.db.close(); });
  return { base, lib, roots, source, asset, cleaner: new MissingFiles(lib) };
}

for (const mode of ['full', 'paths']) test(`external move across registered roots preserves ID and metadata (${mode})`, async t => {
  const f = await setup(t), [oldRoot, targetRoot] = f.roots;
  const destination = path.join(targetRoot.path, 'renamed.wav');
  await fs.rename(f.source, destination);
  await f.cleaner.verify(f.lib.asset(f.asset.id));
  assert.equal(f.lib.asset(f.asset.id).file_status, 'missing');
  if (mode === 'full') await reconcileRoot(f.lib, targetRoot, options);
  else assert.equal((await reconcilePaths(f.lib, targetRoot, ['renamed.wav'], options)).adopted, 1);
  const current = f.lib.asset(f.asset.id);
  assert.equal(current.root_id, targetRoot.id); assert.equal(current.path, destination);
  assert.equal(current.online, 1); assert.equal(current.file_status, 'unknown');
  assert.deepEqual(current.tags, ['keep']); assert.equal(current.note, 'original note'); assert.equal(current.favorite, 1);
  await reconcileRoot(f.lib, oldRoot, options);
  await reconcileRoot(f.lib, targetRoot, options);
  assert.equal(f.lib.list().total, 1); assert.equal(f.lib.list({ view: 'offline' }).total, 0);
  assert.equal((await readManifest(oldRoot)).manifest.entries[f.asset.id], undefined);
  assert.deepEqual((await readManifest(targetRoot)).manifest.entries[f.asset.id].tags, ['keep']);
});

test('copies and hard links do not take ownership from another registered root', async t => {
  const f = await setup(t), destination = path.join(f.roots[1].path, 'copy.wav');
  await fs.copyFile(f.source, destination);
  await reconcileRoot(f.lib, f.roots[1], options);
  assert.equal(f.lib.asset(f.asset.id).path, f.source);
  assert.equal(f.lib.list().total, 2);
  const alias = path.join(f.roots[1].path, 'alias.wav');
  await fs.link(f.source, alias);
  await reconcilePaths(f.lib, f.roots[1], ['alias.wav'], options);
  assert.equal(f.lib.asset(f.asset.id).path, f.source);
});

test('a reachable file marked offline is restored by full reconciliation', async t => {
  const f = await setup(t);
  f.lib.db.prepare("UPDATE assets SET online=0,file_status='offline',file_checked_ms=? WHERE id=?").run(Date.now(), f.asset.id);
  await reconcileRoot(f.lib, f.roots[0], options);
  const current = f.lib.asset(f.asset.id);
  assert.equal(current.online, 1); assert.equal(current.file_status, 'unknown'); assert.equal(current.file_checked_ms, 0);
});

test('quick reconciliation never adopts a different file by only size and extension', async t => {
  const f = await setup(t), destination = path.join(f.roots[0].path, 'different.wav');
  await fs.rename(f.source, path.join(f.base, 'original-outside.wav'));
  await fs.writeFile(destination, 'different audio sample');
  assert.equal((await fs.stat(destination)).size, f.asset.size);
  const result = await reconcilePaths(f.lib, f.roots[0], ['song.wav', 'different.wav'], options);
  assert.equal(result.adopted, 0); assert.equal(result.needFullReconcile, true);
  assert.equal(f.lib.asset(f.asset.id).path, f.source);
});

test('offline cleanup preview verifies missing original only and never deletes its moved file', async t => {
  const f = await setup(t), destination = path.join(f.base, 'outside.wav');
  await fs.rename(f.source, destination);
  f.lib.db.prepare("UPDATE assets SET online=0,file_status='unknown' WHERE id=?").run(f.asset.id);
  const preview = await f.cleaner.checkedCleanupPreview([f.asset.id]);
  assert.equal(preview[0].id, f.asset.id);
  const result = await f.cleaner.clean(preview);
  assert.deepEqual(result.removedIds, [f.asset.id]);
  assert.equal(await fs.readFile(destination, 'utf8'), 'original audio fixture');
  assert.equal((await fs.readdir(path.join(f.lib.dataDir, 'missing-file-backups'))).length, 1);
});

test('unmounted roots, restored originals and changed paths cannot be cleaned from an offline selection', async t => {
  const f = await setup(t);
  await fs.rename(f.roots[0].path, f.roots[0].path + '-disconnected');
  await assert.rejects(f.cleaner.checkedCleanupPreview([f.asset.id]), /已保留记录/);
  assert.ok(f.lib.asset(f.asset.id));
  await fs.rename(f.roots[0].path + '-disconnected', f.roots[0].path);
  await assert.rejects(f.cleaner.checkedCleanupPreview([f.asset.id]), /已保留记录/);
  await fs.unlink(f.source);
  const preview = await f.cleaner.checkedCleanupPreview([f.asset.id]);
  await fs.writeFile(f.source, 'returned');
  assert.equal((await f.cleaner.clean(preview)).removed, 0);
  assert.equal(await fs.readFile(f.source, 'utf8'), 'returned');
});


test('root registration changes at final old-path await deny cross-root adoption and invalid-target fallback', async t => {
  for (const mode of ['paths', 'full']) for (const side of ['source', 'target']) for (const change of ['retired', 'path', 'kind', 'revision']) {
    const f = await setup(t), [sourceRoot, targetRoot] = f.roots, root = side === 'source' ? sourceRoot : targetRoot;
    const destination = path.join(targetRoot.path, 'registration-race.wav');
    await fs.rename(f.source, destination);
    const lstat = fs.lstat; let oldChecks = 0, changed = false;
    fs.lstat = async function(p, ...args) {
      if (String(p) === f.source && ++oldChecks === 2) {
        if (change === 'retired') f.lib.retireRoot(root.id);
        else if (change === 'path') f.lib.db.prepare('UPDATE roots SET path=? WHERE id=?').run(root.path + '-changed', root.id);
        else if (change === 'kind') f.lib.db.prepare('UPDATE roots SET kind=? WHERE id=?').run('sfx', root.id);
        else f.lib.db.prepare('UPDATE roots SET revision=COALESCE(revision,0)+1 WHERE id=?').run(root.id);
        changed = true;
      }
      return lstat.call(this, p, ...args);
    };
    let report;
    try { report = mode === 'full' ? await reconcileRoot(f.lib, targetRoot, options) : await reconcilePaths(f.lib, targetRoot, ['registration-race.wav'], options); }
    finally { fs.lstat = lstat; }
    assert.equal(changed, true, `${mode}/${side}/${change} reached final await barrier`);
    const current = f.lib.asset(f.asset.id);
    assert.equal(current.root_id, sourceRoot.id); assert.equal(current.path, f.source);
    assert.deepEqual(current.tags, ['keep']); assert.equal(current.note, 'original note'); assert.equal(current.favorite, 1);
    assert.equal(mode === 'full' ? report.moved : report.adopted, 0);
    if (side === 'target') {
      assert.equal(f.lib.db.prepare('SELECT COUNT(*) n FROM assets WHERE root_id=?').get(targetRoot.id).n, 0, 'no new index on changed target after adoption refusal');
      assert.equal(report.registrationChanged, true);
    }
    assert.equal(await fs.readFile(destination, 'utf8'), 'original audio fixture');
  }
});

test('operations arriving after backup protect both original index and unbacked operation at final delete transaction', async t => {
  for (const status of ['pending', 'done']) {
    const f = await setup(t); await fs.rename(f.source, path.join(f.base, 'retained-original.wav'));
    const preview = await f.cleaner.checkedCleanupPreview([f.asset.id]);
    const health = f.cleaner.rootHealth.bind(f.cleaner); let calls = 0, inserted = false;
    const operationId = `after-backup-${status}`;
    f.cleaner.rootHealth = async root => {
      const result = await health(root);
      if (++calls === 3) {
        f.lib.db.prepare('INSERT INTO operations(id,asset_id,action,source,target,status,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(operationId, f.asset.id, 'move', f.source, f.source + '.new', status, new Date().toISOString());
        inserted = true;
      }
      return result;
    };
    const result = await f.cleaner.clean(preview);
    assert.equal(inserted, true); assert.equal(result.removed, 0);
    assert.ok(f.lib.db.prepare('SELECT id FROM assets WHERE id=?').get(f.asset.id));
    assert.equal(f.lib.db.prepare('SELECT status FROM operations WHERE id=?').get(operationId).status, status);
    assert.deepEqual(f.lib.asset(f.asset.id).tags, ['keep']);
    const backups = await fs.readdir(path.join(f.lib.dataDir, 'missing-file-backups')); assert.equal(backups.length, 1);
    const backup = JSON.parse((await fs.readFile(path.join(f.lib.dataDir, 'missing-file-backups', backups[0]), 'utf8')).trim());
    assert.equal(backup.related.operations.some(o => o.id === operationId), false, 'new operation was not in the fsynced backup');
  }
});
