import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Library } from '../server/library.mjs';
import { indexFileIdentity, walkFiles } from '../server/fs-identity.mjs';
import { reconcilePaths, reconcileRoot } from '../server/reconcile.mjs';

test('索引只使用精确且为正的文件身份，无法精确表示时不截断或伪造', () => {
  assert.deepEqual(indexFileIdentity({ dev: 7, ino: Number.MAX_SAFE_INTEGER }), { dev: 7, ino: Number.MAX_SAFE_INTEGER });
  for (const ino of [18446744073709550000, Number.MAX_SAFE_INTEGER + 1, -1197, NaN, Infinity, null, 0]) assert.deepEqual(indexFileIdentity({ dev: 7, ino }), { dev: null, ino: null });
  assert.deepEqual(indexFileIdentity({ dev: Number.MAX_SAFE_INTEGER + 1, ino: 1 }), { dev: null, ino: null });
});

test('大编号文件可扫描和重复对账，不因相同的舍入编号误认领，原标签保留', async () => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'unsafe-inode-'))), source = path.join(base, 'synthetic'); await fs.mkdir(source);
  const lib = await new Library(path.join(base, 'data'), { directoryClassification: true }).init(); lib.enqueue = () => {};
  const files = ['unsafe-a.jpg','unsafe-b.jpg','ordinary.jpg'].map(n => path.join(source,n));
  for (const file of files) await fs.writeFile(file,'synthetic-image');
  const raw = fs.stat; const huge = new Set(files.slice(0,2));
  fs.stat = async (...args) => { const stat = await raw(...args); if (huge.has(String(args[0]))) Object.defineProperty(stat, 'ino', { value: 18446744073709550000 }); return stat; };
  try {
    const root = await lib.addRoot(source, 'photo');
    lib.db.exec("CREATE TRIGGER reject_unsafe_inode BEFORE INSERT ON assets WHEN NEW.ino > 9007199254740991 BEGIN SELECT RAISE(ABORT,'unsafe identity'); END");
    async function scan() { const job = lib.scan(root.id); for (let i=0; i<200 && job.status==='running'; i++) await new Promise(r=>setTimeout(r,10)); assert.equal(job.status,'done',JSON.stringify(job)); assert.deepEqual(job.errors,[]); }
    await scan(); await scan();
    const rows = lib.list().items; assert.equal(rows.length,3);
    for (const file of files.slice(0,2)) { const row=rows.find(r=>r.path===file); assert.equal(row.ino,null); assert.equal(row.dev,null); }
    assert.ok(Number.isSafeInteger(rows.find(r=>r.path===files[2]).ino));
    const walked=await walkFiles(root); assert.equal(walked.find(f=>f.abs===files[0]).ino,null);
    const opts={ tagFiles:false, hashBudgetFiles:0, hashBudgetBytes:0, matchHashBudgetFiles:0, matchHashBudgetBytes:0 };
    await reconcileRoot(lib,root,opts); const stable=await reconcileRoot(lib,root,opts); assert.equal(stable.skipped,3); assert.equal(stable.added,0); assert.deepEqual(stable.conflicts,[]);
    const quick=await reconcilePaths(lib,root,['unsafe-a.jpg'],opts); assert.equal(quick.touched,1);
    const original=rows.find(r=>r.path===files[0]); lib.patch(original.id,{note:'保留原记录',tags:['原标签']});
    const moved=path.join(source,'renamed.jpg'); await fs.rename(files[0],moved); huge.add(moved);
    const renamed=await reconcilePaths(lib,root,['unsafe-a.jpg','renamed.jpg'],opts); assert.equal(renamed.adopted,0); assert.equal(renamed.needFullReconcile,true);
    const result=await reconcileRoot(lib,root,opts); assert.equal(result.added,1); assert.deepEqual(result.conflicts,[]);
    assert.equal(lib.asset(original.id).note,'保留原记录'); assert.equal(lib.asset(original.id).online,0);
    const fresh=lib.list().items.find(r=>r.path===moved); assert.notEqual(fresh.id,original.id); assert.equal(fresh.note,''); assert.equal(lib.list().total,4);
  } finally { fs.stat=raw; lib.db.close(); await fs.rm(base,{recursive:true,force:true}); }
});
