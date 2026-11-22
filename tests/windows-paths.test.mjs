import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import Sqlite from 'better-sqlite3';
import {unquotePath,descendantLike} from '../server/path-input.mjs';
import {Library} from '../server/library.mjs';
import {relocateRoot,reconcilePaths} from '../server/reconcile.mjs';
import {ProjectVideoFileOperations} from '../server/project-videos/file-operations.mjs';
import {tempDirectories} from './helpers/temp-cleanup.mjs';
const temporary=tempDirectories(test,'windows-paths-');
test('paired path quotes preserve UNC, drives, internal quotes and unquoted whitespace',()=>{
 for(const value of ['C:\\中文 空格\\片子','\\\\server\\share\\资料','/tmp/含"引号','/tmp/trailing '])assert.equal(unquotePath('"'+value+'"'),value);
 assert.equal(unquotePath('  "C:\\资料"  '),'C:\\资料');
 for(const value of ['/tmp/ x ','"/tmp/unpaired','/tmp/end"'])assert.equal(unquotePath(value),value);
});
test('SQL descendant matching escapes separators, literal percent/underscore, drive and UNC',()=>{
 const db=new Sqlite(':memory:');try{db.exec('CREATE TABLE files(path TEXT)');
 for(const [base,sep] of [['C:\\素材%_\\子','\\'],['\\\\NAS\\share\\素材_','\\'],['/tmp/a%_\\b','/']]){
  db.exec('DELETE FROM files');const wanted=base+sep+'片子.mp4';
  for(const file of [wanted,base+'X'+sep+'片子.mp4',base.replace('%','wild').replace('_','card')+sep+'片子.mp4'])db.prepare('INSERT INTO files VALUES(?)').run(file);
  assert.deepEqual(db.prepare("SELECT path FROM files WHERE path LIKE ? ESCAPE '\\'").all(descendantLike(base,sep)),[{path:wanted}]);
 }
 }finally{db.close();}
});
test('quoted root registration and relocation preflight use the old root for cross-volume fallback',async t=>{
 const dir=await temporary(t),old=path.join(dir,'old'),next=path.join(dir,'new');await fs.mkdir(old);await fs.writeFile(path.join(old,'owned.wav'),'synthetic');await fs.cp(old,next,{recursive:true});
 const lib=await new Library(path.join(dir,'data')).init();lib.enqueue=()=>{};t.after(()=>lib.db.close());
 const root=await lib.addRoot('"'+old+'"','sfx'),job=lib.scan(root.id);
 const end=Date.now()+5000;while(job.status==='running'&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.equal(job.status,'done');
 lib.db.prepare('UPDATE assets SET dev=NULL,ino=NULL').run();
 const result=await relocateRoot(lib,root.id,'"'+next+'"');assert.equal(result.needsConfirm,true);assert.equal(result.matched,1);assert.equal(result.matchRatio,1);assert.equal(lib.rootById(root.id).path,old);
});
test('vanished directory descendant checks treat wildcard names literally',async t=>{
 const dir=await temporary(t),old=path.join(dir,'root');await fs.mkdir(old);
 const lib=await new Library(path.join(dir,'data')).init();lib.enqueue=()=>{};t.after(()=>lib.db.close());
 const root=await lib.addRoot(old,'sfx'),file=path.join(old,'folder%_','owned.wav');
 lib.db.prepare('INSERT INTO assets(id,root_id,path,name,kind,trashed,online) VALUES(?,?,?,?,?,0,1)').run('owned',root.id,file,'owned.wav','sfx');
 const missing=await reconcilePaths(lib,lib.rootById(root.id),['folder%_']);assert.equal(missing.needFullReconcile,true);
 const decoy=await reconcilePaths(lib,lib.rootById(root.id),['folderXX']);assert.equal(decoy.needFullReconcile,false);
});

test('directory move keeps identity, rollback restores payload, conflicts preserve both trees',async t=>{
 const dir=await temporary(t),source=path.join(dir,'source'),target=path.join(dir,'target');
 await fs.mkdir(source);await fs.writeFile(path.join(source,'owned.txt'),'payload');
 const catalog={folders:{rows:()=>[]},videos:{tx:fn=>fn()}};
 const ops=new ProjectVideoFileOperations(catalog,{trash:()=>{throw Error('no trash allowed');}});
 // Exercise real file IO and identity guards independently of unrelated metadata.
 ops.renderGuards=()=>{};ops.assertDatabase=()=>{};ops.save=()=>{};
 const state=async()=>({root:dir,nodes:await ops.snapshot(source),steps:[],sourceRows:[],folderRows:[],moves:[{source,target}]});
 let s=await state();await ops.step('p','r',s,source,target);
 assert.equal(s.steps[0].status,'moved');assert.equal(await fs.readFile(path.join(target,'owned.txt'),'utf8'),'payload');
 assert.equal(String((await fs.stat(target)).ino),s.nodes[0].identity.ino);
 await ops.rollback('p','r',s);assert.equal(await fs.readFile(path.join(source,'owned.txt'),'utf8'),'payload');
 await assert.rejects(fs.stat(target),{code:'ENOENT'});
 await fs.mkdir(target);await fs.writeFile(path.join(target,'other.txt'),'other');s=await state();
 await assert.rejects(ops.step('p','r',s,source,target));
 assert.equal(await fs.readFile(path.join(source,'owned.txt'),'utf8'),'payload');assert.equal(await fs.readFile(path.join(target,'other.txt'),'utf8'),'other');
 await assert.rejects(ops.rollback('p','r',s),{code:'RECOVERY_CONFLICT'});
});
