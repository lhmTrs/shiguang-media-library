import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import express from 'express';
import {Library} from '../server/library.mjs';
import {Projects} from '../server/projects.mjs';
import {ProjectAssets} from '../server/project-assets/store.mjs';
import {StoryboardDatabase} from '../server/storyboard/database.mjs';
import {createStoryboardVideo} from '../server/storyboard-video/index.mjs';
import {ProjectVideos} from '../server/project-videos/store.mjs';
import {FileIntake} from '../server/file-intake/store.mjs';
import {fileIntakeRouter} from '../server/file-intake/router.mjs';
import {IntakePreferences} from '../server/file-intake/preferences.mjs';
import {Receipts,inspectSelection,selectionHash} from '../server/file-intake/files.mjs';
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

test('选择证明：仅ctime元数据变化可收纳，严格绑定的移除仍使用已验证身份',async t=>{
  let removed=0;const f=await fixture(t,{trash:async(file,expected)=>{
    removed++;assert.equal(expected.sha256,(await f.intake.receipts.read('handoffs',handoff.id)).files[0].selectionSha256);
    assert.equal(expected.identity.ctimeMs,(await fs.lstat(file)).ctimeMs);
    const target=file+'.owned-trash';await fs.rename(file,target);return target;
  }});
  const handoff=await f.intake.receipts.handoff([f.file]),original=structuredClone(handoff.files[0].identity);
  await fs.chmod(f.file,0o600);assert.notEqual((await fs.lstat(f.file)).ctimeMs,original.ctimeMs);
  const batch=await f.intake.confirm(handoff.id,{requestId:randomUUID(),projectId:f.project.id,folderId:'root',mode:'move',fileIds:handoff.files.map(x=>x.id)});
  await settled(f.intake);const raw=f.intake.batch(batch.id),item=raw.items[0];
  assert.equal(item.status,'ready');assert.equal(removed,1);assert.deepEqual(item.selectionIdentity,original);
  assert.deepEqual((await f.intake.receipts.read('handoffs',handoff.id)).files[0].identity,original);
  assert.equal((await f.catalog.list(f.project.id)).videos.length,1);
});

test('选择证明：同inode同大小恢复mtime的改字节，以及同内容换inode都拒绝',async t=>{
  const f=await fixture(t);await fs.utimes(f.file,1700000000,1700000000);
  const h=await f.intake.receipts.handoff([f.file]),bytes=await fs.readFile(f.file);bytes[bytes.length-1]^=1;
  await fs.writeFile(f.file,bytes);await fs.utimes(f.file,1700000000,1700000000);
  const a=await f.intake.confirm(h.id,{requestId:randomUUID(),projectId:f.project.id,folderId:'root',mode:'copy',fileIds:h.files.map(x=>x.id)});await settled(f.intake);
  assert.equal(f.intake.batch(a.id).items[0].code,'INTAKE_SOURCE_CHANGED');assert.equal((await f.catalog.list(f.project.id)).videos.length,0);
  const next=await f.intake.receipts.handoff([f.file]);await fs.rename(f.file,f.file+'.kept');await fs.copyFile(f.file+'.kept',f.file);await fs.utimes(f.file,1700000000,1700000000);
  const b=await f.intake.confirm(next.id,{requestId:randomUUID(),projectId:f.project.id,folderId:'root',mode:'copy',fileIds:next.files.map(x=>x.id)});await settled(f.intake);
  assert.equal(f.intake.batch(b.id).items[0].code,'INTAKE_SOURCE_CHANGED');await fs.access(f.file+'.kept');await fs.access(f.file);
});

test('选择证明：后台核验完成前不复制，旧选择没有SHA时不能事后补锚',async t=>{
  const f=await fixture(t),h=await f.intake.receipts.handoff([f.file],{deferFingerprint:true});
  const input={requestId:randomUUID(),projectId:f.project.id,folderId:'root',mode:'copy',fileIds:h.files.map(x=>x.id)};
  await assert.rejects(f.intake.confirm(h.id,input),e=>e.code==='INTAKE_SELECTION_CHECKING');assert.equal(f.intake.batches.size,0);
  const prepared=await f.intake.receipts.prepareHandoff(h.id);assert.equal(prepared.preparation,'ready');
  delete prepared.preparation;delete prepared.files[0].selectionSha256;await f.intake.receipts.write('handoffs',h.id,prepared);
  await fs.chmod(f.file,0o600);const batch=await f.intake.confirm(h.id,input);await settled(f.intake);
  assert.equal(f.intake.batch(batch.id).items[0].code,'INTAKE_SOURCE_CHANGED');assert.equal((await f.catalog.list(f.project.id)).videos.length,0);
});

test('选择证明：复制流必须在发布前匹配选择SHA；证明中止不留下可用锚',async t=>{
  const f=await fixture(t),h=await f.intake.receipts.handoff([f.file]);
  h.files[0].selectionSha256='0'.repeat(64);await f.intake.receipts.write('handoffs',h.id,h);
  const batch=await f.intake.confirm(h.id,{requestId:randomUUID(),projectId:f.project.id,folderId:'root',mode:'copy',fileIds:h.files.map(x=>x.id)});await settled(f.intake);
  assert.equal(f.intake.batch(batch.id).items[0].status,'failed');assert.equal((await f.catalog.list(f.project.id)).videos.length,0);await fs.access(f.file);
  const file=(await inspectSelection([f.file]))[0],controller=new AbortController();controller.abort();
  await assert.rejects(selectionHash(file,{signal:controller.signal}),e=>e.name==='AbortError');
});

test('选择证明：核验过程中修改内容或替换路径都不能生成ready证明',async t=>{
  const f=await fixture(t),originalOpen=fs.open;
  for(const replace of [false,true]){
    const h=await f.intake.receipts.handoff([f.file],{deferFingerprint:true});let changed=false;
    fs.open=async(file,...args)=>{
      const handle=await originalOpen(file,...args);
      if(file===f.file){const read=handle.read.bind(handle);handle.read=async(...a)=>{
        const result=await read(...a);
        if(result.bytesRead&&!changed){changed=true;if(replace){await fs.rename(f.file,f.file+'.proof-kept');await fs.copyFile(f.file+'.proof-kept',f.file);}else await fs.appendFile(f.file,'changed');}
        return result;
      };}
      return handle;
    };
    try{await assert.rejects(f.intake.receipts.prepareHandoff(h.id),e=>e.code==='INTAKE_SOURCE_CHANGED');}
    finally{fs.open=originalOpen;}
    assert.equal(changed,true);assert.equal((await f.intake.receipts.read('handoffs',h.id)).preparation,'failed');await fs.access(f.file);
  }
  assert.equal(f.intake.batches.size,0);
});

test('访达选择接收支持媒体；含不支持文件、目录、链接在任何复制前拒绝',async t=>{
  const f=await fixture(t),txt=path.join(f.dir,'a.txt'),link=path.join(f.dir,'link.mp4');await fs.writeFile(txt,'text');await fs.symlink(f.file,link);
  assert.equal((await inspectSelection([f.file,f.file])).length,1);
  for(const selected of [[f.file,txt],[f.dir],[link]])await assert.rejects(inspectSelection(selected),e=>e.code==='INTAKE_VIDEO_ONLY');
  assert.equal((await f.catalog.list(f.project.id)).videos.length,0);
  assert.match(plist(workflow("/a'b/node",'/safe/script','/private/config')),/fileSystemObject/);
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


test('已处理：持久标记和恢复只影响提醒，保留原失败、完成时间和文件',async t=>{
  const f=await fixture(t),h=await f.intake.receipts.handoff([f.file]);
  await fs.rename(f.file,f.file+'.kept');
  const b=await f.intake.confirm(h.id,{requestId:randomUUID(),projectId:f.project.id,folderId:'root',mode:'copy',fileIds:h.files.map(i=>i.id)});
  await settled(f.intake);const raw=f.intake.batch(b.id),before=structuredClone(raw),completion=f.intake.status().latestCompletion;
  assert.equal(raw.items[0].status,'failed');assert.equal(f.intake.status().needsAttention,1);
  let result=await f.intake.acknowledge(b.id,{acknowledged:true,resultKey:f.intake.dto(raw).resultKey});
  assert.equal(result.acknowledged,true);assert.equal(f.intake.status().needsAttention,0);
  assert.deepEqual(raw.items,before.items);assert.equal(raw.updatedAt,before.updatedAt);assert.deepEqual(f.intake.status().latestCompletion,completion);
  const reloaded=await new FileIntake({dataDir:f.dataDir,catalog:f.catalog,projects:f.projects}).init();
  try{
    assert.equal(reloaded.dto(reloaded.batch(b.id)).acknowledged,true);assert.equal(reloaded.status().needsAttention,0);
    result=await reloaded.acknowledge(b.id,{acknowledged:false,resultKey:result.resultKey});
    assert.equal(result.acknowledged,false);assert.equal(reloaded.status().needsAttention,1);
    const restored=await reloaded.receipts.read('batches',b.id);assert.deepEqual(restored,before);
  }finally{await reloaded.close();}
  await fs.access(f.file+'.kept');assert.equal((await f.catalog.list(f.project.id)).videos.length,0);
});

test('已处理：拒绝在途、不确定、移除未结清和旧结果；写入失败不隐藏提醒',async t=>{
  const f=await fixture(t),id=randomUUID(),itemId=randomUUID();
  const b={id,libraryId:f.intake.libraryId,projectId:f.project.id,folderId:'root',mode:'copy',createdAt:1,updatedAt:2,status:'partial',items:[{id:itemId,status:'failed',code:'SYNTHETIC',bytes:1,copiedBytes:0}]};
  f.intake.batches.set(id,b);await f.intake.save(b,{touch:false});
  const input=()=>({acknowledged:true,resultKey:f.intake.dto(b).resultKey});
  for(const status of ['queued','copying','duplicate','unknown']){
    b.items[0].status=status;await assert.rejects(f.intake.acknowledge(id,input()),e=>e.code==='INTAKE_NOT_SETTLED');
  }
  b.items[0].status='failed';
  for(const status of ['running','queued','waiting']){b.status=status;await assert.rejects(f.intake.acknowledge(id,input()),e=>e.code==='INTAKE_NOT_SETTLED');}b.status='partial';
  b.items[0].removal='planned';await assert.rejects(f.intake.acknowledge(id,input()),e=>e.code==='INTAKE_NOT_SETTLED');delete b.items[0].removal;
  f.intake.finalizing.add(itemId);await assert.rejects(f.intake.acknowledge(id,input()),e=>e.code==='INTAKE_NOT_SETTLED');f.intake.finalizing.delete(itemId);
  const stale=input();b.items[0].error='new failure';await assert.rejects(f.intake.acknowledge(id,stale),e=>e.code==='INTAKE_RESULT_CHANGED');
  const write=f.intake.receipts.write;f.intake.receipts.write=async()=>{throw Error('synthetic write failure');};
  await assert.rejects(f.intake.acknowledge(id,input()),/synthetic write failure/);assert.equal(f.intake.status().needsAttention,1);assert.equal(b.acknowledgment,undefined);f.intake.receipts.write=write;
  await f.intake.acknowledge(id,input());assert.equal(f.intake.status().needsAttention,0);
  b.items[0].error='later explicit operation failure';assert.equal(f.intake.status().needsAttention,1);assert.equal(f.intake.dto(b).acknowledged,false);
  b.libraryId='other library';await assert.rejects(f.intake.acknowledge(id,input()),e=>e.code==='LOCAL_INSTANCE_CHANGED');
});

test('相同回执目录切到另一素材库不改写旧批次或统计旧任务',async t=>{
  const f=await fixture(t),id=randomUUID(),row={id,libraryId:f.intake.libraryId,mode:'move',status:'running',projectId:f.project.id,folderId:'root',items:[{id:randomUUID(),status:'ready',removal:'planned',bytes:1}]};
  await f.intake.receipts.write('batches',id,row);const file=path.join(f.intake.receipts.base,'batches',id+'.json'),before=await fs.readFile(file);
  const foreign=await new FileIntake({dataDir:f.dataDir,libraryId:'different-library',catalog:f.catalog,projects:f.projects}).init();
  try{assert.equal(foreign.list().batches.length,0);assert.equal(foreign.status().activeCount,0);assert.equal(foreign.status().needsAttention,0);assert.deepEqual(await fs.readFile(file),before);}finally{await foreign.close();}
});

test('project-video preview is read-only; concurrent confirms reserve names and replay keeps the original choice',async t=>{
  const f=await fixture(t);
  f.intake.preferences=await new IntakePreferences({dataDir:f.dataDir,libraryId:f.intake.libraryId}).init();
  f.intake.generic={}; // all writes go through the real project-video catalog
  const root=await f.catalog.folders.rootPath(f.project.id),make=async(name,file,manual)=>{
    const h=await f.intake.receipts.handoff([file]),destination={kind:'video',scope:'project',projectId:f.project.id,folderId:name};
    if(manual)destination.fileName=manual;
    const args={version:2,requestId:randomUUID(),mode:'copy',standardNames:true,fileIds:h.files.map(i=>i.id),
      targets:h.files.map(i=>({fileId:i.id,nameMode:'standard',destination}))};
    return {h,args};
  };
  const a=await make('root',f.file);
  assert.deepEqual((await f.intake.namePreview(a.h.id,a.args)).items.map(i=>i.proposedFileName),['右键项目_001.mp4']);
  await assert.rejects(fs.access(root),{code:'ENOENT'});
  await assert.rejects(fs.access(f.intake.preferences.file),{code:'ENOENT'});
  const folder=await f.catalog.folders.create(f.project.id,{name:'外景',parentId:'root',requestId:randomUUID()});
  const bFile=path.join(f.dir,'clip2.mp4'),cFile=path.join(f.dir,'clip3.mp4');
  const bytes=await fs.readFile(f.file);
  await fs.writeFile(bFile,Buffer.concat([bytes,Buffer.from('two')]));
  await fs.writeFile(cFile,Buffer.concat([bytes,Buffer.from('three')]));
  const b=await make(folder.id,bFile),c=await make(folder.id,cFile);
  const folderPath=path.join(root,'外景'),prefix='右键项目_外景_';
  await fs.writeFile(path.join(folderPath,prefix+'008.mov'),bytes);
  await fs.mkdir(path.join(folderPath,prefix+'900.mp4'));
  await fs.symlink(path.join(folderPath,prefix+'008.mov'),path.join(folderPath,prefix+'901.mp4'));
  assert.equal((await f.intake.namePreview(b.h.id,b.args)).items[0].proposedNumber,9);
  await fs.writeFile(path.join(folderPath,prefix+'009.mp4'),bytes);
  const kick=f.intake.kick.bind(f.intake);
  f.intake.kick=()=>{};
  const [acceptedB,acceptedC]=await Promise.all([f.intake.confirm(b.h.id,b.args),f.intake.confirm(c.h.id,c.args)]);
  assert.deepEqual([acceptedB,acceptedC].map(b=>b.items[0].plannedFileName),[prefix+'010.mp4',prefix+'011.mp4']);
  const replay=await f.intake.confirm(b.h.id,b.args);
  assert.equal(replay.items[0].plannedFileName,prefix+'010.mp4');
  assert.deepEqual(replay.items[0].destination,b.args.targets[0].destination);
  assert.equal(replay.items[0].nameMode,'standard');
  const preferences=await f.intake.intakePreferences();
  assert.equal(preferences.routingPreferences.lastVideoFolderByProject[f.project.id],folder.id);
  assert.equal(preferences.routingPreferences.standardNames,true);
  await assert.rejects(f.intake.confirm(b.h.id,{...b.args,standardNames:false}),{code:'INTAKE_ALREADY_ACCEPTED'});
  const manual=await make(folder.id,f.file,'手动.mp4');
  assert.equal((await f.intake.namePreview(manual.h.id,manual.args)).items[0].proposedFileName,'手动.mp4');
  f.intake.kick=kick;kick();await settled(f.intake);
  for(const b of [acceptedB,acceptedC]){
    const item=f.intake.dto(f.intake.batch(b.id)).items[0];
    assert.equal(item.status,'ready',item.error);assert.equal(item.resultFileName,item.plannedFileName);
  }
});

test('a removed video folder is omitted from suggestions and explicit confirmation does not redirect',async t=>{
  const f=await fixture(t);
  f.intake.preferences=await new IntakePreferences({dataDir:f.dataDir,libraryId:f.intake.libraryId}).init();
  f.intake.generic={
    db:f.lib.db,
    async choices(){return {folders:[]};},
  };
  const folder=await f.catalog.folders.create(f.project.id,{name:'临时目录',parentId:'root',requestId:randomUUID()});
  const destination={kind:'video',scope:'project',projectId:f.project.id,folderId:folder.id};
  await f.intake.preferences.remember([destination]);
  const handoff=await f.intake.receipts.handoff([f.file]);
  const fileIds=handoff.files.map(i=>i.id),requestId=randomUUID();
  const request={version:2,mode:'copy',requestId,fileIds,targets:[{fileId:fileIds[0],destination,nameMode:'standard'}]};
  const app=express();
  app.use(fileIntakeRouter(f.intake,{}));
  const server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
  t.after(()=>new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve())));
  const url='http://127.0.0.1:'+server.address().port;
  const get=async pathname=>{
    const response=await fetch(url+pathname);
    assert.equal(response.status,200);
    return response.json();
  };
  assert.equal((await get('/preferences')).targets.video.folderId,folder.id);
  const root=await f.catalog.folders.rootPath(f.project.id);
  await fs.rename(path.join(root,folder.name),path.join(f.dir,'removed-folder'));
  const rejected=await fetch(url+'/handoffs/'+handoff.id+'/confirm',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),
  });
  assert.equal(rejected.status,409);
  const failure=await rejected.json();
  assert.deepEqual([failure.code,failure.accepted,failure.requestId],['TARGET_CHANGED',false,requestId]);
  const preferences=await get('/preferences');
  assert.equal(preferences.targets.video.folderId,'root');
  assert.equal(preferences.routingPreferences.lastVideoFolderByProject[f.project.id],'root');
  assert.equal((await get('/handoffs/'+handoff.id)).preferences.video.folderId,'root');
  const options=await get('/routing-options');
  assert.deepEqual(options.projects.find(p=>p.id===f.project.id).videoFolders.map(p=>p.id),['root']);
  assert.deepEqual((await get('/projects/'+f.project.id+'/folders')).folders.map(p=>p.id),['root']);
  await fs.mkdir(path.join(root,folder.name));
  assert.equal((await get('/preferences')).targets.video.folderId,'root');
  const preview=await fetch(url+'/handoffs/'+handoff.id+'/name-preview',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),
  });
  assert.equal(preview.status,200);
  assert.equal((await preview.json()).items[0].error.code,'TARGET_CHANGED');
  assert.equal(f.intake.batches.size,0);
  assert.deepEqual(await fs.readdir(path.join(root,folder.name)),[]);
  await fs.access(f.file);
});
