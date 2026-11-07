import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {Library} from '../server/library.mjs';
test('existing reveal selects exact registered file via injected opener; count only after success, no file changes',async()=>{
 const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'look-reveal-')));let lib;
 try{
  lib=await new Library(path.join(dir,'data')).init();const images=path.join(dir,'images');await fs.mkdir(images);const file=path.join(images,'当前图片.png'),bytes=Buffer.from('owned synthetic image bytes');await fs.writeFile(file,bytes);const root=await lib.addRoot(images,'photo'),id=randomUUID();lib.db.prepare('INSERT INTO assets(id,root_id,path,name,ext,kind,size,mtime) VALUES(?,?,?,?,?,?,?,?)').run(id,root.id,file,'当前图片.png','png','photo',bytes.length,Date.now());const opened=[];
  const shown=await lib.reveal(id,p=>opened.push(p));assert.deepEqual(opened,[file]);assert.equal(shown.reveal_count,1);assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'),createHash('sha256').update(bytes).digest('hex'));
  await assert.rejects(lib.reveal(id,()=>{throw Error('synthetic opener refused');}),/opener refused/);assert.equal(lib.asset(id).reveal_count,1);
  await fs.unlink(file);await assert.rejects(lib.reveal(id,p=>opened.push(p)),/ENOENT/);assert.equal(opened.length,1);assert.equal(lib.asset(id).reveal_count,1);
  await fs.writeFile(file,bytes);lib.db.prepare('UPDATE assets SET trashed=1 WHERE id=?').run(id);await assert.rejects(lib.reveal(id,p=>opened.push(p)),/废纸篓/);assert.equal(opened.length,1);
 }finally{lib?.db.close();await fs.rm(dir,{recursive:true,force:true});}
});
