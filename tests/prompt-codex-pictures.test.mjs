import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Library} from '../server/library.mjs';
import {CodexMedia,sha256} from '../server/prompt-codex/media.mjs';
import {CodexPictures,projectFolderName} from '../server/prompt-codex/pictures.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=','base64');
async function setup(t){const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'codex-picture-'))),lib=await new Library(path.join(base,'data'),{directoryClassification:true}).init();lib.enqueue=()=>{};const generatedDirectory=path.join(base,'generated_images'),media=await new CodexMedia(lib.dataDir,{generatedDirectory}).init();const directory=path.join(base,'personal_item','picture');let refreshes=0;const pictures=new CodexPictures(lib,{directory,onRootAdded:()=>{refreshes++;}});t.after(async()=>{await pictures.queue;lib.db.close();await fs.rm(base,{recursive:true,force:true});});return{base,lib,media,pictures,directory,generatedDirectory,refreshes:()=>refreshes};}
test('Codex savedPath and fileId-only outputs read only the matching generated image; inline images remain supported',async t=>{
 const s=await setup(t),threadId=randomUUID(),itemId='exec-'+randomUUID(),directory=path.join(s.generatedDirectory,threadId);await fs.mkdir(directory,{recursive:true});const file=path.join(directory,itemId+'.png');await fs.writeFile(file,png);const scratch=await s.media.scratch(randomUUID());
 for(const item of [{id:itemId,savedPath:file},{id:itemId,fileId:'provider-file-id'},{id:itemId,result:png.toString('base64')}])assert.deepEqual(await s.media.receive(item,{scratch,threadId}),png);
 await assert.rejects(s.media.receive({id:itemId,savedPath:file},{scratch,threadId:randomUUID()}),/与本次生成任务不匹配/);
 await assert.rejects(s.media.receive({id:'../other',fileId:'file'},{scratch,threadId}),/标识无效/);
 const unrelated=path.join(s.base,'unrelated.png');await fs.writeFile(unrelated,png);await assert.rejects(s.media.receive({id:itemId,savedPath:unrelated},{scratch,threadId}),/与本次生成任务不匹配/);
 await fs.unlink(file);await fs.symlink(unrelated,file);await assert.rejects(s.media.receive({id:itemId,savedPath:file},{scratch,threadId}),/符号链接/);
});
test('Default picture directory is created and registered once; concurrent saves are indexed and duplicate callbacks do not duplicate files',async t=>{
 const s=await setup(t);assert.equal(s.lib.roots().length,0);const initialized=await s.pictures.initialize(),again=await s.pictures.initialize();assert.deepEqual(again,initialized);assert.equal(s.refreshes(),1);assert.equal(s.lib.roots()[0].kind,'photo');
 const rows=await Promise.all([s.media.save(png,randomUUID()),s.media.save(png,randomUUID())]);const results=await Promise.all(rows.map(row=>s.pictures.publish(row,png)));const repeated=await s.pictures.publish(rows[0],png);assert.equal(repeated.assetId,results[0].assetId);assert.equal(s.lib.roots().length,1);
 assert.equal(s.lib.list({kind:'photo'}).total,2);assert.equal((await fs.readdir(path.join(s.directory,'未选择项目'))).filter(n=>n.endsWith('.png')).length,2);for(let i=0;i<rows.length;i++){assert.equal(results[i].status,'ready');assert.deepEqual(await fs.readFile(path.join(s.directory,results[i].relativePath)),png);assert.deepEqual(await s.media.read(rows[i]),png);}
});
test('Existing covering root is reused; retired roots are not silently restored',async t=>{
 const s=await setup(t);await fs.mkdir(path.dirname(s.directory));const root=await s.lib.addRoot(path.dirname(s.directory),'mixed');const row=await s.media.save(png,randomUUID());assert.equal((await s.pictures.publish(row,png)).rootId,root.id);assert.equal(s.lib.roots().length,1);s.lib.retireRoot(root.id);
 await assert.rejects(s.pictures.publish(row,png),/已注销/);assert.equal(s.lib.rootById(root.id).retired,1);assert.deepEqual(await s.media.read(row),png);
});
test('Personal folder symlinks, read-only mode and conflicting target files never redirect or overwrite an image',async t=>{
 const s=await setup(t),row=await s.media.save(png,randomUUID()),outside=path.join(s.base,'outside');await fs.mkdir(outside);await fs.symlink(outside,path.dirname(s.directory));await assert.rejects(s.pictures.publish(row,png),/目录无效/);assert.deepEqual(await fs.readdir(outside),[]);await fs.unlink(path.dirname(s.directory));
 const before=process.env.MEDIA_READONLY_FILES;process.env.MEDIA_READONLY_FILES='1';try{await assert.rejects(s.pictures.publish(row,png),e=>e.status===403);await assert.rejects(fs.access(s.directory));}finally{if(before===undefined)delete process.env.MEDIA_READONLY_FILES;else process.env.MEDIA_READONLY_FILES=before;}
 await s.pictures.initialize();await fs.mkdir(path.join(s.directory,'未选择项目'));const target=path.join(s.directory,'未选择项目','Codex-'+row.file_name);await fs.writeFile(target,'existing-owner-file');await assert.rejects(s.pictures.publish(row,png),/未覆盖/);assert.equal(await fs.readFile(target,'utf8'),'existing-owner-file');assert.deepEqual(await s.media.read(row),png);assert.equal((await fs.readdir(path.dirname(target))).some(n=>n.endsWith('.partial')),false);
});
test('Index failure keeps both original and managed copy and does not claim a successful import',async t=>{
 const s=await setup(t),row=await s.media.save(png,randomUUID());s.lib.scan=()=>({status:'failed',errors:['synthetic failure']});await assert.rejects(s.pictures.publish(row,png),/素材索引未完成/);assert.deepEqual(await fs.readFile(path.join(s.directory,'未选择项目','Codex-'+row.file_name)),png);assert.deepEqual(await s.media.read(row),png);
});
test('项目分目录保持不同项目隔离，同一项目改名仍用原目录，文件和素材路径一致',async t=>{
 const s=await setup(t),a={id:randomUUID(),name:'同名项目'},b={id:randomUUID(),name:'同名项目'},rows=await Promise.all([s.media.save(png,randomUUID()),s.media.save(png,randomUUID())]);const first=await s.pictures.publish(rows[0],png,a),second=await s.pictures.publish(rows[1],png,b);assert.notEqual(path.dirname(first.relativePath),path.dirname(second.relativePath));
 const renamed=await s.pictures.publish(rows[0],png,{...a,name:'项目改名后'});assert.equal(renamed.relativePath,first.relativePath);assert.equal(renamed.assetId,first.assetId);assert.equal(renamed.projectName,'项目改名后');assert.equal(s.lib.roots().length,1);assert.deepEqual(await fs.readFile(path.join(s.directory,first.relativePath)),png);assert.equal(s.lib.asset(first.assetId).path,path.join(s.directory,first.relativePath));
});
test('项目名特殊字符和长中文不会产生越界路径，同项目重复目录或符号链接拒绝写入',async t=>{
 const s=await setup(t),project={id:randomUUID(),name:'../\\CON:测试?*'+ '长'.repeat(80)},name=projectFolderName(project);assert.ok(!/[<>:"/\\|?*]/.test(name));assert.ok(Buffer.byteLength(name)<255);assert.ok(!name.startsWith('.'));const row=await s.media.save(png,randomUUID());await s.pictures.initialize();const outside=path.join(s.base,'outside-project');await fs.mkdir(outside);await fs.symlink(outside,path.join(s.directory,name));await assert.rejects(s.pictures.publish(row,png,project),/目录无效/);assert.deepEqual(await fs.readdir(outside),[]);await fs.unlink(path.join(s.directory,name));
 await fs.mkdir(path.join(s.directory,'甲--'+project.id));await fs.mkdir(path.join(s.directory,'乙--'+project.id));await assert.rejects(s.pictures.publish(row,png,project),/多个图片文件夹/);assert.deepEqual(await s.media.read(row),png);
});
