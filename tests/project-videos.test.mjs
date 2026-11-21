import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomUUID}from'node:crypto';import {Readable}from'node:stream';import {spawnSync}from'node:child_process';
import {Library}from'../server/library.mjs';import {Projects}from'../server/projects.mjs';import {ProjectAssets}from'../server/project-assets/store.mjs';import {StoryboardDatabase}from'../server/storyboard/database.mjs';import {createStoryboardVideo}from'../server/storyboard-video/index.mjs';import {ProjectVideos}from'../server/project-videos/store.mjs';import {syntheticSource}from'./helpers/storyboard-fixture.mjs';import {digest,canonical}from'../server/project-assets/model.mjs';
// 网页上传、升级和重新定位的接收副本会留在系统临时目录（只有 Finder 收纳会在核对后清掉，升级副本的位置也不落库），
// 所以每个夹具把 TMPDIR 指到自己的目录里，测试结束随目录一起删掉。
async function privateTmp(t,dir){const previous=process.env.TMPDIR,tmp=path.join(dir,'tmp');await fs.mkdir(tmp);process.env.TMPDIR=tmp;assert.equal(os.tmpdir(),tmp);t.after(()=>{if(previous===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=previous;});}
async function fixture(t){const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-project-video-test-')));await privateTmp(t,dir);const lib=await new Library(path.join(dir,'data')).init();lib.enqueue=()=>{};const projects=new Projects(lib).init(),assets=new ProjectAssets(lib).init(),storyboards=new StoryboardDatabase(lib,assets).init(),entry=createStoryboardVideo({lib,storyboards}),catalog=new ProjectVideos(entry.store,{directory:path.join(dir,'personal_item','video')}),a=projects.save(null,{name:'视频项目甲'}),b=projects.save(null,{name:'视频项目乙'});t.after(async()=>{await catalog.close();await entry.close();assert.equal(entry.media.children.size,0);assert.equal(entry.media.handles.size,0);lib.db.close();await fs.rm(dir,{recursive:true,force:true});});const file=path.join(dir,'original.mp4');const run=spawnSync(process.env.VIDEO_V2_FFMPEG||'ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=green:s=96x64:r=8:d=4','-c:v','libx264','-pix_fmt','yuv420p','-threads','1',file]);assert.equal(run.status,0,run.stderr?.toString());const bytes=await fs.readFile(file);return{dir,lib,projects,assets,storyboards,entry,store:entry.store,v2:entry.bindingV2,catalog,a,b,file,bytes};}
async function imported(f,prompt={mode:'none'},name='candidate.mp4',extra={}){const requestId=randomUUID();await f.catalog.start(f.a.id,{requestId,fileName:name,bytes:f.bytes.length,prompt,...extra});return f.catalog.upload(f.a.id,requestId,Readable.from([f.bytes]));}
// 段A的起点必须指向换过ID后的第一个镜头，否则分镜初始化报 SEGMENT_STRUCTURE_INVALID。
function init(f){const p=syntheticSource(),shot=p.scenes[0].shots[0];p.scenes[0].shots=Array.from({length:3},(_,i)=>({...structuredClone(shot),id:'shot_'+randomUUID(),duration_ms:1000,dialogue:[]}));p.segments[0].start_shot_id=p.scenes[0].shots[0].id;return f.storyboards.initialize(f.a.id,{source:p,request_id:randomUUID(),expected_revision:null});}
// 绑定与采用走 v2（旧截段接口自 #126 起返回 410），写法同 tests/helpers/video-binding-v2-fixture.mjs 的 bind/select。
const shotAt=(f,i)=>f.v2.state(f.a.id).shots[i].shotId;
async function bind(f,videoId,indices,sourceProjectId=f.a.id){const view=f.storyboards.read(f.a.id),before=f.v2.sourceBinding(sourceProjectId,videoId),intent={action:'bind',expectedBindingRevision:before.bindingRevision,targetProjectId:f.a.id,expectedStoryboardRevision:view.revision,expectedAssetStamp:view.asset_stamp,shotIds:indices.map(i=>shotAt(f,i))},preview=await f.v2.previewBinding(sourceProjectId,videoId,intent);return f.v2.bind(sourceProjectId,videoId,{...intent,requestId:randomUUID(),previewHash:preview.previewHash,...(preview.requiresConfirmation?{confirmUnbind:true,confirmedUnbindShotIds:preview.affectedShots.map(s=>s.shotId)}:{})});}
function selectionIntent(f,videoId,action='adopt-video'){const state=f.v2.state(f.a.id),binding=f.v2.sourceBinding(f.a.id,videoId);return {action,expectedSelectionRevision:state.context.selectionRevision,expectedStoryboardRevision:state.context.storyboardRevision,sourceProjectId:f.a.id,videoId,bindingId:binding.binding.bindingId,expectedBindingRevision:binding.bindingRevision};}
function adopt(f,videoId){const intent=selectionIntent(f,videoId),preview=f.v2.previewSelection(f.a.id,intent);return f.v2.select(f.a.id,{...intent,requestId:randomUUID(),previewHash:preview.previewHash,...(preview.requiresConfirmation?{confirmReplace:true}:{})});}
// 绑定与采用的完整现状：用来核对升级、重新定位前后没有被改动。
const bindingState=(f,videoIds)=>({shots:f.v2.state(f.a.id).shots,selectionRevision:f.v2.state(f.a.id).context.selectionRevision,bindings:videoIds.map(id=>{const b=f.v2.sourceBinding(f.a.id,id);return {bindingRevision:b.bindingRevision,binding:b.binding};})});
const adoptedBy=(f,videoId)=>f.v2.state(f.a.id).shots.filter(s=>s.adopted?.videoId===videoId).map(s=>s.number);
test('旧视频升级入口按全项目托管现状重新开启，缺读取授权仍须重新定位',async t=>{
 const f=await fixture(t),id=f.a.id;
 init(f);
 const managed=await imported(f,{mode:'none'},'managed.mp4');
 const relink=await imported(f,{mode:'none'},'relink.mp4');
 const stableSource=f.store.source(id,managed.videoId);
 const relinkSource=f.store.source(id,relink.videoId);
 await bind(f,managed.videoId,[0]);adopt(f,managed.videoId);
 await bind(f,relink.videoId,[1]);adopt(f,relink.videoId);
 assert.deepEqual(adoptedBy(f,managed.videoId),['01']);
 assert.deepEqual(adoptedBy(f,relink.videoId),['02']);
 const before=bindingState(f,[managed.videoId,relink.videoId]);
 f.store.tx(()=>f.catalog.folders.completeUpgrade(id));
 assert.deepEqual((await f.catalog.list(id,{folderId:'all'})).legacyUpgrade,{count:0,completed:true});

 const probe=await f.entry.media.probe(f.file),now=Date.now(),legacyId=randomUUID(),removedId=randomUUID();
 f.lib.db.prepare('INSERT INTO storyboard_video_sources VALUES(?,?,?,?,?)').run(legacyId,id,canonical(probe),now,now);
 f.store.approve({id:legacyId,project_id:id,...probe});
 f.lib.db.prepare('INSERT INTO storyboard_video_sources VALUES(?,?,?,?,?)').run(removedId,id,canonical(probe),now,now);
 f.catalog.remove(id,removedId,{expectedRevision:0,adoptionStamp:f.catalog.adoption(id).stamp});
 f.lib.db.prepare('DELETE FROM storyboard_video_approvals WHERE id=?').run(relink.videoId);
 // 缺读取授权：分镜里仍保留绑定和采用，片子显示为不可信，镜头标为待复核
 assert.equal(f.v2.shotVideos(id,shotAt(f,1)).items[0].status,'untrusted');
 const untrusted=bindingState(f,[managed.videoId,relink.videoId]);
 assert.deepEqual(untrusted.bindings,before.bindings);
 assert.deepEqual(untrusted.shots.map(s=>s.adopted),before.shots.map(s=>s.adopted));
 assert.deepEqual(untrusted.shots[1].reviewReasons.map(r=>r.category),['dependency_unverifiable']);

 const emptyFolder=await f.catalog.folders.create(id,{requestId:randomUUID(),name:'空目录',parentId:'root'});
 const status=t.mock.method(f.store,'status');
 const filtered=await f.catalog.list(id,{folderId:emptyFolder.id});
 const all=await f.catalog.list(id,{folderId:'all'});
 assert.equal(status.mock.callCount(),0,'全项目计数不检查其他目录的文件');
 assert.equal(filtered.videos.length,0);
 assert.deepEqual(filtered.legacyUpgrade,{count:2,completed:false});
 assert.deepEqual(all.legacyUpgrade,filtered.legacyUpgrade);
 assert.equal(f.catalog.folders.settings(id).upgradeCompleted,true);

 const plan=await f.catalog.upgradePlan(id);
 assert.equal(plan.completed,false);
 assert.deepEqual(new Map(plan.items.map(item=>[item.id,[item.status,item.requiresRelink]])),new Map([
  [legacyId,['available',false]],[relink.videoId,['untrusted',true]],
 ]));
 const requestId=randomUUID();
 await f.catalog.upgrade(id,{requestId,previewHash:plan.previewHash});
 const deadline=Date.now()+5000;
 while(f.catalog.receipt(id,requestId).status==='running'&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
 const receipt=f.catalog.receipt(id,requestId);
 assert.equal(receipt.status,'failed');
 assert.deepEqual(new Map(receipt.results.map(item=>[item.sourceId,item.status])),new Map([[legacyId,'ready'],[relink.videoId,'failed']]));
 assert.equal(f.store.authorized(relinkSource),false);
 assert.deepEqual(f.store.source(id,managed.videoId),stableSource);
 assert.deepEqual(await fs.readFile(f.file),f.bytes);
 assert.deepEqual((await f.catalog.list(id,{folderId:'all'})).legacyUpgrade,{count:1,completed:false});

 const expectedRevision=f.catalog.metadata(id,relinkSource).row.revision;
 const resolved=await f.catalog.relink(id,relink.videoId,{requestId:randomUUID(),expectedRevision,path:relinkSource.path});
 assert.equal(resolved.status,'ready');
 assert.deepEqual((await f.catalog.list(id,{folderId:'all'})).legacyUpgrade,{count:0,completed:true});
 const emptyPlan=await f.catalog.upgradePlan(id);
 assert.equal(emptyPlan.completed,true);
 assert.deepEqual(emptyPlan.items,[]);
 // 重新定位后原绑定、采用和修订号都不变，片子恢复可用
 assert.deepEqual(bindingState(f,[managed.videoId,relink.videoId]),before);
 assert.equal(f.v2.shotVideos(id,shotAt(f,1)).items[0].status,'available');
});
for(const [when,change] of [['before','retire'],['after','revoke'],['after','replace']]){
 test(`升级复制期间并发变化：${when}/${change} 不得重新授权或遗留未登记副本`,async t=>{
  const f=await fixture(t),id=f.a.id,sourceId=randomUUID(),now=Date.now(),probe=await f.entry.media.probe(f.file);
  f.lib.db.prepare('INSERT INTO storyboard_video_sources VALUES(?,?,?,?,?)').run(sourceId,id,canonical(probe),now,now);
  const original=f.store.source(id,sourceId);
  f.store.approve(original);
  f.store.tx(()=>f.catalog.folders.completeUpgrade(id));
  const target=(await f.catalog.prepare(id)).target,final=path.join(target,probe.name);
  const changeSource=()=>{
   if(change==='retire')f.catalog.remove(id,sourceId,{expectedRevision:0,adoptionStamp:f.catalog.adoption(id).stamp});
   else f.lib.db.prepare('DELETE FROM storyboard_video_approvals WHERE id=? AND project_id=?').run(sourceId,id);
  };
  let staged=false;
  if(when==='before'){
   const candidates=f.catalog.candidates.bind(f.catalog);
   t.mock.method(f.catalog,'candidates',async attempt=>{
    const found=await candidates(attempt);
    assert.deepEqual(await fs.readFile(attempt.stage),f.bytes);
    changeSource();staged=true;
    return found;
   });
  }else{
   const baseline=f.catalog.verification.baseline.bind(f.catalog.verification);
   t.mock.method(f.catalog.verification,'baseline',async (file,hash)=>{
    const fingerprint=await baseline(file,hash);
    assert.equal(file.path,final);
    assert.deepEqual(await fs.readFile(final),f.bytes);
    changeSource();staged=true;
    if(change==='replace'){
     await fs.rename(final,final+'.moved');
     await fs.writeFile(final,'另一个进程放入的文件');
    }
    return fingerprint;
   });
  }
  const plan=await f.catalog.upgradePlan(id),requestId=randomUUID();
  await f.catalog.upgrade(id,{requestId,previewHash:plan.previewHash});
  const deadline=Date.now()+5000;
  while(f.catalog.receipt(id,requestId).status==='running'&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  const receipt=f.catalog.receipt(id,requestId);
  assert.equal(staged,true);
  assert.equal(receipt.status,'failed');
  assert.deepEqual(f.store.source(id,sourceId),original);
  assert.deepEqual(await fs.readFile(f.file),f.bytes);
  assert.equal(f.lib.db.prepare('SELECT id FROM assets WHERE path=?').get(final),undefined);
  if(change==='retire')assert.ok(f.catalog.metadata(id,original).data.removedAt);
  else assert.equal(f.store.authorized(original),false);
  if(change==='replace'){
   assert.match(receipt.results[0].error,/状态待核对/);
   assert.equal(await fs.readFile(final,'utf8'),'另一个进程放入的文件');
   assert.deepEqual(await fs.readFile(final+'.moved'),f.bytes);
  }else assert.deepEqual((await fs.readdir(target)).filter(name=>name.endsWith('.mp4')),[]);
 });
}
test('升级副本跨卷回退用独占文件并返回可核对的身份',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sg-upgrade-cross-copy-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const staging=path.join(dir,'shiguang-project-video-import-fixture'),target=path.join(dir,'target'),preload=path.join(dir,'link-exdev.mjs');
 await fs.mkdir(staging);await fs.mkdir(target);
 await fs.writeFile(preload,"import fs from 'node:fs/promises'; fs.link=async()=>{throw Object.assign(Error('cross device fixture'),{code:'EXDEV'})};");
 const stage=path.join(staging,'original.partial'),bytes=Buffer.alloc(1024*1024,83);
 await fs.writeFile(stage,bytes);
 const {dev,ino}=await fs.stat(target),original=await fs.stat(stage);
 const stageIdentity=[original.dev,original.ino,original.size,original.mtimeMs,original.ctimeMs].join(':');
 const worker=path.resolve(import.meta.dirname,'../server/project-videos/publish-worker.mjs');
 const run=input=>{
  const proc=spawnSync(process.execPath,['--import',preload,worker,JSON.stringify({directory:{dev,ino},...input})],{cwd:target,encoding:'utf8',timeout:5000});
  assert.equal(proc.status,0,proc.stderr||String(proc.error));
  return JSON.parse(proc.stdout);
 };
 const publication=run({stage,stageIdentity,fileName:'candidate.mp4',reportIdentity:true}),file=path.join(target,publication.fileName);
 assert.notEqual((await fs.stat(file)).ino,original.ino);
 assert.deepEqual(await fs.readFile(file),bytes);
 assert.deepEqual(run({discard:publication}),{discarded:true});
 assert.deepEqual(await fs.readdir(target),[]);
 assert.deepEqual(await fs.readFile(stage),bytes);
});
test('回退在检查后遇到同名换入，保留换入文件且不覆盖新占用',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sg-upgrade-rollback-race-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const preload=path.join(dir,'replace-before-rename.mjs'),worker=path.resolve(import.meta.dirname,'../server/project-videos/publish-worker.mjs');
 await fs.writeFile(preload,`import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
 const rename=fs.renameSync;
 fs.renameSync=(from,to)=>{
  if(from!=='candidate.mp4')return rename(from,to);
  rename(from,'retained.mp4');fs.writeFileSync(from,'换入的文件');
  rename(from,to);
  if(process.cwd().endsWith('occupied'))fs.writeFileSync(from,'又出现的同名文件');
 };
 syncBuiltinESMExports();`);
 for(const type of ['free','occupied']){
  const target=path.join(dir,type),fileName='candidate.mp4',file=path.join(target,fileName);
  await fs.mkdir(target);await fs.writeFile(file,'原副本');
  const {dev,ino}=await fs.stat(target),st=await fs.stat(file),identity=[st.dev,st.ino,st.size,st.mtimeMs,st.ctimeMs].join(':');
  const proc=spawnSync(process.execPath,['--import',preload,worker,JSON.stringify({directory:{dev,ino},discard:{fileName,identity}})],{cwd:target,encoding:'utf8',timeout:5000});
  assert.equal(proc.status,1,proc.stderr||String(proc.error));
  assert.equal(await fs.readFile(path.join(target,'retained.mp4'),'utf8'),'原副本');
  const isolated=(await fs.readdir(target)).filter(name=>name.startsWith('.sg-upgrade-rollback-'));
  if(type==='free'){
   assert.match(proc.stderr,/已放回原位置/);
   assert.equal(await fs.readFile(file,'utf8'),'换入的文件');
   assert.deepEqual(isolated,[]);
  }else{
   assert.equal(isolated.length,1);
   assert.ok(proc.stderr.includes(path.join(isolated[0],fileName)));
   assert.equal(await fs.readFile(file,'utf8'),'又出现的同名文件');
   assert.equal(await fs.readFile(path.join(target,isolated[0],fileName),'utf8'),'换入的文件');
  }
 }
});
test('无分镜项目可持久保存视频、none/new/existing参考提示词、项目归属与备份',async t=>{const f=await fixture(t),r=await imported(f,{mode:'new',title:'门口经验',text:'固定镜头，原参考经验正文'});assert.equal(r.status,'ready');const list=await f.catalog.list(f.a.id),v=list.videos[0];assert.equal(list.prompts.length,1);assert.equal(v.managed,true);assert.equal(v.status,'available');assert.deepEqual(v.adoptedShots,[]);assert.notEqual(v.path,f.file);assert.deepEqual(await fs.readFile(v.path),f.bytes);assert.deepEqual(await fs.readFile(f.file),f.bytes);await assert.rejects(f.catalog.start(f.b.id,{requestId:randomUUID(),fileName:'b.mp4',bytes:100,prompt:{mode:'existing',id:list.prompts[0].id}}),e=>e.code==='PROMPT_NOT_FOUND');const upd=await f.catalog.update(f.a.id,v.id,{expectedRevision:v.revision,title:'新标题',notes:'可读备注',prompt:{mode:'existing',id:list.prompts[0].id}});assert.equal(upd.name,'新标题');const backup=f.storyboards.backup();assert.equal(backup.video_preview.project_video_records.length,1);f.storyboards.validateBackup(backup);const bad=structuredClone(backup);bad.video_preview.project_video_records[0].project_id=f.b.id;bad.checksum=digest({tables:bad.tables,creative:bad.creative,video_preview:bad.video_preview,change_history:bad.change_history});assert.throws(()=>f.storyboards.validateBackup(bad),/归属/);const restarted=new ProjectVideos(f.store,{directory:f.catalog.directory});assert.equal((await restarted.list(f.a.id)).videos[0].name,'新标题');assert.equal(restarted.receiptDTO(restarted.receipt(f.a.id,r.id)).status,'ready');});
test('同内容不同名直接导入、同名可复用或_0副本；重复请求查询不重发',async t=>{const f=await fixture(t),one=await imported(f),two=await imported(f,{mode:'none'},'other.mp4');assert.equal(two.status,'ready');assert.notEqual(two.videoId,one.videoId);assert.equal((await f.catalog.list(f.a.id)).videos.length,2);const again=await imported(f);assert.equal(again.status,'duplicate');const copied=await f.catalog.resolve(f.a.id,again.id,{choice:'import'});assert.equal(copied.fileName,'candidate_0.mp4');assert.equal((await f.catalog.list(f.a.id)).videos.length,3);await assert.rejects(f.catalog.upload(f.a.id,again.id,Readable.from([f.bytes])),e=>e.code==='IMPORT_BUSY');assert.equal(f.catalog.receiptDTO(f.catalog.receipt(f.a.id,again.id)).status,'ready');});
test('分镜仅绑定项目管理视频，覆盖与参考提示词无关，移除需精确采用确认',async t=>{
 const f=await fixture(t);init(f);
 const a=await imported(f),duplicate=await imported(f,{mode:'new',text:'另一份经验'}),b=await f.catalog.resolve(f.a.id,duplicate.id,{choice:'import'});
 // 只认当前项目“生成视频”里管理的视频：别的项目、未托管的旧来源都不能绑定
 await assert.rejects(bind(f,a.videoId,[0],f.b.id),e=>e.code==='SOURCE_NOT_FOUND');
 const probe=await f.entry.media.probe(f.file),legacyId=randomUUID(),now=Date.now();
 f.lib.db.prepare('INSERT INTO storyboard_video_sources VALUES(?,?,?,?,?)').run(legacyId,f.a.id,canonical(probe),now,now);
 f.store.approve({id:legacyId,project_id:f.a.id,...probe});
 await assert.rejects(bind(f,legacyId,[0]),e=>e.code==='VIDEO_BINDING_CONFLICT'&&e.details.mediaErrorCode==='SOURCE_UNTRUSTED');
 await bind(f,a.videoId,[0,1]);adopt(f,a.videoId);
 const oldFirst=f.v2.state(f.a.id).shots[0].adopted;
 assert.equal(oldFirst.videoId,a.videoId);
 // b 覆盖第2镜的采用：要明确确认替换，第1镜不受影响
 await bind(f,b.videoId,[1,2]);
 const replace=f.v2.previewSelection(f.a.id,selectionIntent(f,b.videoId));
 assert.equal(replace.requiresConfirmation,true);
 assert.deepEqual(replace.changes.filter(c=>c.before).map(c=>[c.number,c.before.videoId]),[['02',a.videoId]]);
 adopt(f,b.videoId);
 let list=await f.catalog.list(f.a.id);
 assert.deepEqual(list.videos.find(v=>v.id===a.videoId).adoptedShots.map(s=>s.number),['01']);
 // 列表里的采用镜头按镜头ID排序（镜头ID是随机的），这里只比集合
 assert.deepEqual(list.videos.find(v=>v.id===b.videoId).adoptedShots.map(s=>s.number).sort(),['02','03']);
 assert.deepEqual(f.v2.state(f.a.id).shots[0].adopted,oldFirst);
 assert.equal(f.v2.sourceBinding(f.a.id,b.videoId).binding.targetProjectId,f.a.id);
 let video=list.videos.find(v=>v.id===b.videoId);
 const affected=video.adoptedShots.map(s=>({projectId:s.projectId,shotId:s.id}));
 await assert.rejects(Promise.resolve().then(()=>f.catalog.remove(f.a.id,video.id,{expectedRevision:video.revision,adoptionStamp:list.adoptionStamp})),e=>e.code==='UNBIND_CONFIRMATION_REQUIRED');
 // 改备注和参考提示词不改变采用关系
 await f.catalog.update(f.a.id,video.id,{expectedRevision:video.revision,title:video.name,notes:'经验只读',prompt:{mode:'none'}});
 list=await f.catalog.list(f.a.id);
 video=list.videos.find(v=>v.id===b.videoId);
 assert.deepEqual(adoptedBy(f,b.videoId),['02','03']);
 assert.equal(f.v2.state(f.a.id).shots.filter(s=>s.adopted).length,3);
 // 确认集合必须与当前采用完全一致，少一镜也不行
 await assert.rejects(Promise.resolve().then(()=>f.catalog.remove(f.a.id,video.id,{expectedRevision:video.revision,adoptionStamp:list.adoptionStamp,confirmUnbind:true,confirmedUnbindShotRefs:affected.slice(0,1)})),e=>e.code==='UNBIND_CONFIRMATION_REQUIRED');
 assert.deepEqual(adoptedBy(f,b.videoId),['02','03']);
 f.catalog.remove(f.a.id,video.id,{expectedRevision:video.revision,adoptionStamp:list.adoptionStamp,confirmUnbind:true,confirmedUnbindShotRefs:affected});
 const after=f.v2.state(f.a.id);
 assert.deepEqual(after.shots.filter(s=>s.adopted).map(s=>[s.number,s.adopted.videoId]),[['01',a.videoId]]);
 assert.equal(f.v2.sourceBinding(f.a.id,b.videoId).binding,null);
 assert.deepEqual(adoptedBy(f,a.videoId),['01']);
 await fs.access(video.path);
 await assert.rejects(bind(f,video.id,[2]),e=>e.code==='VIDEO_BINDING_CONFLICT'&&e.details.mediaErrorCode==='SOURCE_UNTRUSTED');
});
test('旧来源复制升级保留原ID；失败项原关联保留，后续只处理未完成项',async t=>{
 const f=await fixture(t);init(f);
 const bound=await imported(f,{mode:'none'},'bound.mp4');
 await bind(f,bound.videoId,[0]);adopt(f,bound.videoId);
 const probe=await f.entry.media.probe(f.file),sourceId=randomUUID(),now=Date.now();
 f.lib.db.prepare('INSERT INTO storyboard_video_sources VALUES(?,?,?,?,?)').run(sourceId,f.a.id,canonical(probe),now,now);
 f.store.approve({id:sourceId,project_id:f.a.id,...probe});
 const missingId=randomUUID();
 f.lib.db.prepare('INSERT INTO storyboard_video_sources VALUES(?,?,?,?,?)').run(missingId,f.a.id,canonical({...probe,path:path.join(f.dir,'gone.mp4'),name:'gone.mp4'}),now,now);
 // 升级前旧来源未托管，不能绑定
 await assert.rejects(bind(f,sourceId,[1]),e=>e.code==='VIDEO_BINDING_CONFLICT'&&e.details.mediaErrorCode==='SOURCE_UNTRUSTED');
 const before=bindingState(f,[bound.videoId]),plan=await f.catalog.upgradePlan(f.a.id),requestId=randomUUID();
 await f.catalog.upgrade(f.a.id,{requestId,previewHash:plan.previewHash});
 while(f.catalog.receipt(f.a.id,requestId).status==='running')await new Promise(r=>setTimeout(r,20));
 const receipt=f.catalog.receipt(f.a.id,requestId);
 assert.equal(receipt.status,'failed');
 assert.equal(receipt.results.find(r=>r.sourceId===sourceId).status,'ready');
 assert.equal(receipt.results.find(r=>r.sourceId===missingId).status,'failed');
 // 升级不改动已有绑定和采用
 assert.deepEqual(bindingState(f,[bound.videoId]),before);
 assert.notEqual(f.store.source(f.a.id,sourceId).path,probe.path);
 assert.equal(f.store.source(f.a.id,missingId).path,path.join(f.dir,'gone.mp4'));
 assert.deepEqual(await fs.readFile(f.file),f.bytes);
 assert.deepEqual((await f.catalog.upgradePlan(f.a.id)).items.map(v=>v.id),[missingId]);
 // 升级后沿用原来源ID，进入项目管理，可以直接绑定采用
 await bind(f,sourceId,[1]);adopt(f,sourceId);
 assert.deepEqual(adoptedBy(f,sourceId),['02']);
 assert.deepEqual(adoptedBy(f,bound.videoId),['01']);
});
test('重新定位只接受相同内容，保留绑定；短接收失败不创建来源',async t=>{
 const f=await fixture(t);init(f);
 const r=await imported(f);
 await bind(f,r.videoId,[0]);adopt(f,r.videoId);
 const v=(await f.catalog.list(f.a.id)).videos[0],before=bindingState(f,[r.videoId]);
 assert.deepEqual(adoptedBy(f,r.videoId),['01']);
 const copy=path.join(f.dir,'relocated.mp4'),other=path.join(f.dir,'other-content.mp4');
 await fs.copyFile(v.path,copy);
 const encoded=spawnSync(process.env.VIDEO_V2_FFMPEG||'ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=red:s=96x64:r=8:d=4','-c:v','libx264','-pix_fmt','yuv420p','-threads','1',other]);
 assert.equal(encoded.status,0,encoded.stderr?.toString());
 await fs.rename(v.path,v.path+'.moved');
 assert.equal((await f.catalog.list(f.a.id)).videos[0].status,'missing');
 assert.equal(f.v2.shotVideos(f.a.id,shotAt(f,0)).items[0].status,'missing');
 // 内容不同的文件不能顶替原视频，绑定保持原样
 await assert.rejects(f.catalog.relink(f.a.id,v.id,{requestId:randomUUID(),expectedRevision:v.revision,path:other}),e=>e.code==='SOURCE_CHANGED');
 const rejected=bindingState(f,[r.videoId]);
 assert.deepEqual(rejected.bindings,before.bindings);
 assert.deepEqual(rejected.shots.map(s=>s.adopted),before.shots.map(s=>s.adopted));
 assert.deepEqual(rejected.shots[0].reviewReasons.map(x=>x.category),['dependency_unverifiable']);
 assert.equal((await f.catalog.list(f.a.id)).videos[0].status,'missing');
 const relinkId=randomUUID(),relinkInput={requestId:relinkId,expectedRevision:v.revision,path:copy};
 await f.catalog.relink(f.a.id,v.id,relinkInput);
 assert.equal(f.catalog.receipt(f.a.id,relinkId).status,'ready');
 assert.equal((await f.catalog.relink(f.a.id,v.id,relinkInput)).status,'ready');
 assert.deepEqual(bindingState(f,[r.videoId]),before);
 assert.equal((await f.catalog.list(f.a.id)).videos[0].status,'available');
 assert.equal(f.v2.shotVideos(f.a.id,shotAt(f,0)).items[0].status,'available');
 const id=randomUUID();
 await f.catalog.start(f.a.id,{requestId:id,fileName:'short.mp4',bytes:f.bytes.length+1,prompt:{mode:'none'}});
 await assert.rejects(f.catalog.upload(f.a.id,id,Readable.from([f.bytes])),e=>e.code==='INVALID_LENGTH');
 assert.equal(f.catalog.receiptDTO(f.catalog.receipt(f.a.id,id)).status,'failed');
 assert.equal((await f.catalog.list(f.a.id)).videos.length,1);
});

test('移除后复用同一文件，分镜精确绑定本次选中的新来源ID',async t=>{
 const f=await fixture(t);init(f);
 const one=await imported(f);
 await bind(f,one.videoId,[0]);adopt(f,one.videoId);
 let list=await f.catalog.list(f.a.id),v=list.videos[0];
 f.catalog.remove(f.a.id,v.id,{expectedRevision:v.revision,adoptionStamp:list.adoptionStamp,confirmUnbind:true,confirmedUnbindShotRefs:v.adoptedShots.map(s=>({projectId:s.projectId,shotId:s.id}))});
 assert.equal(f.v2.state(f.a.id).shots[0].adopted,null);
 const again=await imported(f);
 assert.equal(again.status,'duplicate');
 const next=await f.catalog.resolve(f.a.id,again.id,{choice:'reuse',candidateId:again.candidates[0].id});
 assert.notEqual(next.videoId,one.videoId);
 // 旧来源ID已移除，不能再绑定；绑定落在本次复用得到的新来源ID上
 await assert.rejects(bind(f,one.videoId,[0]),e=>e.code==='VIDEO_BINDING_CONFLICT'&&e.details.mediaErrorCode==='SOURCE_UNTRUSTED');
 const bound=await bind(f,next.videoId,[0]);
 assert.equal(bound.binding.bindingId,next.videoId);
 adopt(f,next.videoId);
 const shot=f.v2.state(f.a.id).shots[0];
 assert.equal(shot.adopted.videoId,next.videoId);
 assert.equal(shot.defaultVideo.videoId,next.videoId);
 assert.deepEqual(f.v2.shotVideos(f.a.id,shot.shotId).items.map(item=>item.videoId),[next.videoId]);
 assert.equal(f.v2.sourceBinding(f.a.id,one.videoId).binding,null);
});
test('备份资料不能自行赋予管理资格，也不能借用其他素材封面或打开入口',async t=>{const f=await fixture(t);const importedVideo=await imported(f),source=f.store.source(f.a.id,importedVideo.videoId);assert.equal(f.catalog.isManaged(f.a.id,source),true);const proof=f.catalog.managedKey(source.id);f.lib.db.prepare('DELETE FROM storyboard_video_approvals WHERE id=?').run(proof);assert.equal(f.catalog.isManaged(f.a.id,source),false);assert.equal((await f.catalog.list(f.a.id)).videos[0].thumbnailUrl,null);assert.throws(()=>f.catalog.assertBindable(f.a.id,source.id),e=>e.code==='PROJECT_VIDEO_REQUIRED');f.catalog.approveManaged(source);const row=f.catalog.metadata(f.a.id,source);f.lib.db.prepare('UPDATE project_video_records SET data_json=? WHERE id=?').run(canonical({...row.data,mediaAssetId:randomUUID()}),source.id);assert.equal(f.catalog.isManaged(f.a.id,source),false);let revealed=false;f.lib.reveal=async()=>{revealed=true;};await assert.rejects(f.catalog.reveal(f.a.id,source.id));assert.equal(revealed,false);assert.equal((await f.catalog.list(f.a.id)).videos[0].thumbnailUrl,null);});

test('保持同名重新定位会更新物理索引，回执始终绑定路由来源',async t=>{const f=await fixture(t);init(f);const one=await imported(f);await bind(f,one.videoId,[0]);adopt(f,one.videoId);const before=bindingState(f,[one.videoId]),old=(await f.catalog.list(f.a.id)).videos.find(v=>v.id===one.videoId),destination=path.join(f.dir,'moved');await fs.mkdir(destination);const moved=path.join(destination,path.basename(old.path));await fs.rename(old.path,moved);const requestId=randomUUID(),input={requestId,expectedRevision:old.revision,path:moved,sourceId:'extra-client-field'};const receipt=await f.catalog.relink(f.a.id,one.videoId,input);assert.equal(receipt.status,'ready');const after=(await f.catalog.list(f.a.id)).videos.find(v=>v.id===one.videoId);assert.equal(after.path,old.path);assert.equal(after.managed,true);assert.equal(after.status,'available');assert.deepEqual(bindingState(f,[one.videoId]),before);assert.equal(f.v2.shotVideos(f.a.id,shotAt(f,0)).items[0].status,'available');await f.v2.previewBinding(f.a.id,one.videoId,{action:'bind',expectedBindingRevision:before.bindings[0].bindingRevision,targetProjectId:f.a.id,expectedStoryboardRevision:f.storyboards.read(f.a.id).revision,expectedAssetStamp:f.storyboards.read(f.a.id).asset_stamp,shotIds:[shotAt(f,0)]});const dup=await imported(f),two=await f.catalog.resolve(f.a.id,dup.id,{choice:'import'});await assert.rejects(f.catalog.relink(f.a.id,two.videoId,input),e=>e.code==='REQUEST_ID_CONFLICT');assert.deepEqual(await fs.readFile(moved),f.bytes);});
