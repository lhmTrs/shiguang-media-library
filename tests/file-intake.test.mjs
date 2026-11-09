import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Library} from '../server/library.mjs';
import {Projects} from '../server/projects.mjs';
import {ProjectAssets} from '../server/project-assets/store.mjs';
import {StoryboardDatabase} from '../server/storyboard/database.mjs';
import {createStoryboardVideo} from '../server/storyboard-video/index.mjs';
import {ProjectVideos} from '../server/project-videos/store.mjs';
import {FileIntake} from '../server/file-intake/store.mjs';
import {Receipts,inspectSelection} from '../server/file-intake/files.mjs';
import {workflow,plist,shellQuote} from '../server/file-intake/native.mjs';

async function fixture(t,{trash}={}) {
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-file-intake-test-')));
  const dataDir=path.join(dir,'data'),lib=await new Library(dataDir).init();lib.enqueue=()=>{};
  const projects=new Projects(lib).init(),assets=new ProjectAssets(lib).init(),storyboards=new StoryboardDatabase(lib,assets).init();
  const entry=createStoryboardVideo({lib,storyboards}),catalog=new ProjectVideos(entry.store,{directory:path.join(dir,'video')});
  const intake=await new FileIntake({dataDir,catalog,projects,trash}).init();
  const project=projects.save(null,{name:'右键项目'}),other=projects.save(null,{name:'另一项目'});
  const file=path.join(dir,'clip.mp4');
  const ffmpeg=process.env.FFMPEG_PATH||'/opt/homebrew/bin/ffmpeg';
  const generated=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=green:s=64x64:r=2:d=1',
    '-c:v','libx264','-pix_fmt','yuv420p','-threads','1',file]);assert.equal(generated.status,0,generated.stderr?.toString());
  t.after(async()=>{await intake.close();await entry.close();assert.equal(entry.media.handles.size,0);assert.equal(entry.media.children.size,0);lib.db.close();});
  return {dir,dataDir,lib,projects,storyboards,entry,catalog,intake,project,other,file};
}
async function accept(f,files,mode='copy',extra={}) {
  const h=await f.intake.receipts.handoff(files),input={requestId:randomUUID(),projectId:f.project.id,folderId:'root',mode,fileIds:h.files.map(i=>i.id),...extra};
  const batch=await f.intake.confirm(h.id,input);return {h,input,batch};
}
async function settled(store) {
  const end=Date.now()+10000;
  while(store.work||store.status().activeCount){if(Date.now()>end)throw Error('bounded intake timeout');await new Promise(r=>setTimeout(r,10));}
}

test('访达选择只接收单/多视频；混选、目录、链接在任何复制前拒绝',async t=>{
  const f=await fixture(t),txt=path.join(f.dir,'a.txt'),link=path.join(f.dir,'link.mp4');await fs.writeFile(txt,'text');await fs.symlink(f.file,link);
  assert.equal((await inspectSelection([f.file,f.file])).length,1);
  for(const selected of [[f.file,txt],[f.dir],[link]])await assert.rejects(inspectSelection(selected),e=>e.code==='INTAKE_VIDEO_ONLY');
  assert.equal((await f.catalog.list(f.project.id)).videos.length,0);
  assert.match(plist(workflow("/a'b/node",'/safe/script','/private/config')),/fileSystemObject.movie/);
  assert.equal(shellQuote("a'b"),"'a'\"'\"'b'");
});

test('真实目录和导入：后台目标固定、重复确认不重复复制、只复制选中项且保留原文件',async t=>{
  const f=await fixture(t),two=path.join(f.dir,'two.mov');await fs.copyFile(f.file,two);
  const folder=await f.catalog.folders.create(f.project.id,{requestId:randomUUID(),name:'已选择目录',parentId:'root'});
  const h=await f.intake.receipts.handoff([f.file,two]);
  const input={requestId:randomUUID(),projectId:f.project.id,folderId:folder.id,mode:'copy',fileIds:[h.files[0].id]};
  const first=await f.intake.confirm(h.id,input),again=await f.intake.confirm(h.id,input);assert.equal(first.id,again.id);
  await assert.rejects(f.intake.confirm(h.id,{...input,projectId:f.other.id}),e=>e.code==='INTAKE_ALREADY_ACCEPTED');
  await settled(f.intake);const b=f.intake.dto(f.intake.batch(first.id));assert.equal(b.status,'completed');assert.equal(b.items[0].status,'ready');
  const videos=(await f.catalog.list(f.project.id)).videos;assert.equal(videos.length,1);assert.equal(videos[0].folderId,folder.id);
  assert.equal((await f.catalog.list(f.other.id)).videos.length,0);assert.deepEqual(await fs.readFile(videos[0].path),await fs.readFile(f.file));
  assert.equal((await f.intake.handoff(h.id)).batchId,first.id);await fs.access(two);
});

test('单项失败不回滚其他项，同名等待不挡后续，明确改名复用既有导入',async t=>{
  const f=await fixture(t);await accept(f,[f.file]);await settled(f.intake);
  const second=path.join(f.dir,'second.mp4');await fs.copyFile(f.file,second);
  const missing=path.join(f.dir,'gone.mp4');await fs.copyFile(f.file,missing);
  const h=await f.intake.receipts.handoff([f.file,missing,second]);await fs.unlink(missing);
  const b=await f.intake.confirm(h.id,{requestId:randomUUID(),projectId:f.project.id,folderId:'root',mode:'copy',fileIds:h.files.map(i=>i.id)});
  await settled(f.intake);let result=f.intake.dto(f.intake.batch(b.id));assert.deepEqual(result.items.map(i=>i.status),['duplicate','failed','ready']);
  result=await f.intake.resolve(b.id,result.items[0].id,{choice:'import'});assert.equal(result.items[0].status,'ready');
  const list=await f.catalog.list(f.project.id);assert.equal(list.videos.length,3);assert.ok(list.videos.some(v=>v.fileName==='clip_0.mp4'||path.basename(v.path)==='clip_0.mp4'));
});

test('只有副本完整登记才移至废纸篓；移除失败单列成功副本且不重拷',async t=>{
  const f=await fixture(t,{trash:async()=>{throw Error('合成废纸篓不可用');}}),{batch}=await accept(f,[f.file],'move');
  await settled(f.intake);const b=f.intake.dto(f.intake.batch(batch.id));assert.equal(b.items[0].status,'source_retained');
  assert.match(b.items[0].error,/已收纳/);assert.equal((await f.catalog.list(f.project.id)).videos.length,1);await fs.access(f.file);
  await assert.rejects(f.intake.retry(batch.id,b.items[0].id),e=>e.code==='INTAKE_RETRY_REFUSED');
});

test('本方合成移动成功保留字节；已管理文件不复制也不移除，标签和镜号记录保留',async t=>{
  let f;f=await fixture(t,{trash:async file=>{const trash=path.join(f.dir,'.Trash');await fs.mkdir(trash,{recursive:true});const target=path.join(trash,path.basename(file));await fs.rename(file,target);return target;}});
  const original=await fs.readFile(f.file),{batch}=await accept(f,[f.file],'move');await settled(f.intake);
  const raw=f.intake.batch(batch.id);assert.equal(raw.items[0].removal,'complete');assert.equal(raw.items[0].status,'ready');
  await assert.rejects(fs.access(f.file));assert.deepEqual(await fs.readFile(raw.items[0].trashPath),original);
  const v=(await f.catalog.list(f.project.id)).videos[0],asset=f.lib.db.prepare('SELECT * FROM assets WHERE path=?').get(v.path);
  f.lib.db.prepare('UPDATE assets SET note=?,tags=? WHERE id=?').run('原备注','["原标签"]',asset.id);
  const next=await accept(f,[v.path],'move');await settled(f.intake);const row=f.intake.batch(next.batch.id).items[0];
  assert.equal(row.status,'managed');assert.equal(row.videoId,v.id);assert.equal((await f.catalog.list(f.project.id)).videos.length,1);
  assert.equal(f.lib.db.prepare('SELECT note FROM assets WHERE id=?').get(asset.id).note,'原备注');await fs.access(v.path);
});

test('中断后不自动重发；核对原成功回执，另一库实例不能继续旧任务',async t=>{
  const f=await fixture(t),{batch}=await accept(f,[f.file]);await settled(f.intake);
  const b=f.intake.batch(batch.id);b.items[0].status='copying';b.status='running';await f.intake.save(b);
  const restarted=await new FileIntake({dataDir:f.dataDir,catalog:f.catalog,projects:f.projects}).init();
  assert.equal(restarted.dto(restarted.batch(b.id)).status,'interrupted');assert.equal(restarted.work,null);
  const read=await restarted.reconcile(b.id);assert.equal(read.items[0].status,'ready');assert.equal((await f.catalog.list(f.project.id)).videos.length,1);
  const another=await new FileIntake({dataDir:f.dataDir,catalog:f.catalog,projects:f.projects,libraryId:'another-library'}).init();
  await assert.rejects(another.reconcile(b.id),e=>e.code==='LOCAL_INSTANCE_CHANGED');await restarted.close();await another.close();
  const outside=new Receipts(f.dataDir);await assert.rejects(outside.read('handoffs','../../etc/passwd'),e=>e.code==='INTAKE_NOT_FOUND');
});

test('确认后来源变化或目标目录替换会失败，不能回落项目根目录或移除原件',async t=>{
  const f=await fixture(t,{trash:async()=>assert.fail('changed inputs must never be trashed')});
  let release;const gate=new Promise(r=>{release=r;});f.intake.withActivity=fn=>gate.then(fn);
  const folder=await f.catalog.folders.create(f.project.id,{requestId:randomUUID(),name:'固定目标',parentId:'root'});
  const {batch}=await accept(f,[f.file],'move',{folderId:folder.id});
  await fs.rename(folder.path,folder.path+'-old');await fs.mkdir(folder.path);release();await settled(f.intake);
  const b=f.intake.dto(f.intake.batch(batch.id));assert.equal(b.items[0].status,'failed');await fs.access(f.file);
  assert.equal((await f.catalog.list(f.project.id)).videos.length,0);
});

test('复制流期间原件变化则不登记和删除；失败重试只影响该项',async t=>{
  const f=await fixture(t,{trash:async()=>assert.fail('changed source must never be trashed')});
  const originalUpload=f.catalog.upload.bind(f.catalog);
  f.catalog.upload=async(id,request,stream)=>originalUpload(id,request,(async function*(){
    for await(const chunk of stream){yield chunk;await fs.appendFile(f.file,'changed after first chunk');}
  })());
  const {batch}=await accept(f,[f.file],'move');await settled(f.intake);
  const b=f.intake.dto(f.intake.batch(batch.id));assert.equal(b.items[0].status,'failed');assert.equal((await f.catalog.list(f.project.id)).videos.length,0);
  await fs.access(f.file);await assert.rejects(f.intake.retry(batch.id,b.items[0].id),e=>e.code==='INTAKE_SOURCE_CHANGED');
});

test('应用到后续项也处理已到达的重名等待；坏回执不阻止App启动或改写原文件',async t=>{
  const f=await fixture(t);await accept(f,[f.file]);await settled(f.intake);
  const anotherDir=path.join(f.dir,'another');await fs.mkdir(anotherDir);const another=path.join(anotherDir,path.basename(f.file));await fs.copyFile(f.file,another);
  const {batch}=await accept(f,[f.file,another]);await settled(f.intake);
  assert.deepEqual(f.intake.batch(batch.id).items.map(i=>i.status),['duplicate','duplicate']);
  const result=await f.intake.resolve(batch.id,batch.items[0].id,{choice:'import',applyRemaining:true});
  assert.deepEqual(result.items.map(i=>i.status),['ready','ready']);assert.equal((await f.catalog.list(f.project.id)).videos.length,3);
  const id=randomUUID(),file=f.intake.receipts.file('batches',id);await fs.writeFile(file,'{bad',{mode:0o600});
  const next=await new FileIntake({dataDir:f.dataDir,catalog:f.catalog,projects:f.projects}).init();
  assert.equal(next.initializationError,undefined);assert.equal(next.batch(id).items[0].status,'unknown');
  await assert.rejects(next.reconcile(id),e=>e.code==='INTAKE_RECEIPT_INVALID');assert.equal(await fs.readFile(file,'utf8'),'{bad');await next.close();
});

test('末次目标核验期间原路径被替换：不调用废纸篓，原件与新文件均保留',async t=>{
  let calls=0;const f=await fixture(t,{trash:async()=>{calls++;assert.fail('replacement must not be trashed');}});
  const verify=f.catalog.media.verify.bind(f.catalog.media),kept=f.file+'.original-kept';let replaced=false;
  f.catalog.media.verify=async source=>{
    await verify(source);
    if(!replaced&&[...f.intake.batches.values()].some(b=>b.items.some(i=>i.removal==='planned'))) {
      replaced=true;await fs.rename(f.file,kept);await fs.copyFile(kept,f.file);await fs.appendFile(f.file,'replacement');
    }
  };
  const {batch}=await accept(f,[f.file],'move');await settled(f.intake);
  assert.equal(replaced,true);assert.equal(calls,0);await fs.access(kept);await fs.access(f.file);
  assert.equal(f.intake.batch(batch.id).items[0].status,'unknown');
  assert.equal((await f.catalog.list(f.project.id)).videos.length,1);
});

test('本次成功副本完成后仅清理自己的stage，目标仍可验证；重名/未知/历史stage保留',async t=>{
  const f=await fixture(t),{batch}=await accept(f,[f.file]);await settled(f.intake);
  const item=f.intake.batch(batch.id).items[0],raw=f.catalog.receipt(f.project.id,item.requestId);
  assert.equal(raw.stageCleanup.complete,true);await assert.rejects(fs.access(raw.cache),e=>e.code==='ENOENT');
  const source=await f.catalog.verifiedSource(f.project.id,item.videoId);await f.catalog.media.verify(source);
  assert.notEqual(source.identity.ino,raw.stageStat.ino);
  const duplicate=await accept(f,[f.file]);await settled(f.intake);
  const d=f.intake.batch(duplicate.batch.id).items[0],pending=f.catalog.receipt(f.project.id,d.requestId);
  assert.equal(pending.status,'duplicate');await fs.access(pending.stage);
  await f.catalog.cleanupIntakeStage(f.project.id,pending.id);await fs.access(pending.stage);
  for(const change of [{status:'unknown'},{status:'ready',instance:'old-instance'}]){
    Object.assign(pending,change);f.catalog.persist(pending);await f.catalog.cleanupIntakeStage(f.project.id,pending.id);await fs.access(pending.stage);
  }
});

test('临时目录被替换则保留两边文件并显示收尾提示，不影响已成功正式视频',async t=>{
  const f=await fixture(t),cleanup=f.catalog.cleanupIntakeStage.bind(f.catalog);let saved;
  f.catalog.cleanupIntakeStage=async(id,request)=>{
    const raw=f.catalog.receipt(id,request);saved=raw.cache+'-kept';await fs.rename(raw.cache,saved);await fs.mkdir(raw.cache,{mode:0o700});
    await fs.writeFile(path.join(raw.cache,'original.partial'),'unrelated');return cleanup(id,request);
  };
  const {batch}=await accept(f,[f.file]);await settled(f.intake);
  const item=f.intake.batch(batch.id).items[0];assert.equal(item.status,'ready');assert.match(item.error,/临时副本保留/);
  await fs.access(path.join(saved,'original.partial'));
  const raw=f.catalog.receipt(f.project.id,item.requestId);assert.equal(await fs.readFile(path.join(raw.cache,'original.partial'),'utf8'),'unrelated');
  await f.catalog.media.verify(await f.catalog.verifiedSource(f.project.id,item.videoId));
});

test('移除计划写入后中断：重启显示未知，不自动再次移除原件',async t=>{
  const f=await fixture(t),{batch}=await accept(f,[f.file]);await settled(f.intake);
  const b=f.intake.batch(batch.id);b.mode='move';b.items[0].removal='planned';b.status='running';await f.intake.save(b);
  const next=await new FileIntake({dataDir:f.dataDir,catalog:f.catalog,projects:f.projects,trash:()=>assert.fail('no automatic removal after restart')}).init();
  assert.equal(next.batch(b.id).items[0].status,'unknown');assert.equal(next.work,null);await fs.access(f.file);
  const result=await next.reconcile(b.id);assert.equal(result.items[0].status,'source_retained');await fs.access(f.file);await next.close();
});
