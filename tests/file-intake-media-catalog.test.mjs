import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {Library} from '../server/library.mjs';
import {Projects} from '../server/projects.mjs';
import {ProjectAssets} from '../server/project-assets/store.mjs';
import {VideoMedia} from '../server/storyboard-video/media.mjs';
import {ManagedIntakeCatalog} from '../server/file-intake/media-catalog.mjs';
import {FileIntake} from '../server/file-intake/store.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=','base64');
const sha=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t,{libraryId}={}) {
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-managed-intake-test-'))), dataDir=path.join(dir,'data');
  const lib=await new Library(dataDir,{directoryClassification:true}).init();lib.enqueue=()=>{};
  const projects=new Projects(lib).init(),assets=new ProjectAssets(lib).init(),media=new VideoMedia();
  media.probe=()=>assert.fail('Generic catalog must not run a video/audio/image engine');
  const catalog={lib,media,db:lib.db},options={catalog,assets,dataDir,directory:path.join(dir,'personal_item'),...(libraryId===undefined?{}:{libraryId})};
  const managed=await new ManagedIntakeCatalog(options).init();
  assert.equal(managed.initializationError,undefined);
  const project=projects.save(null,{name:'合成项目甲'}),other=projects.save(null,{name:'合成项目乙'});
  t.after(async()=>{
    assert.equal(media.handles.size,0);assert.equal(media.children.size,0);assert.equal(media.exits.size,0);
    await media.close();
    for(const s of managed.receipts.list()) if(s.cache && path.dirname(s.cache)===await fs.realpath(os.tmpdir()) && path.basename(s.cache).startsWith('shiguang-project-video-import-'))
      await fs.rm(s.cache,{recursive:true,force:true});
    lib.db.close();await fs.rm(dir,{recursive:true,force:true});
  });
  return {dir,dataDir,lib,db:lib.db,projects,assets,media,catalog,options,managed,project,other};
}
async function prepared(f,d,options) {
  const target=await f.managed.prepare(d,options);
  return {target,bound:f.managed.bind(d,target)};
}
async function start(f,d,{target,bound}={},fileName='test.png',bytes=png,requestId=randomUUID()) {
  if(!bound) ({target,bound}=await prepared(f,d));
  const input={requestId,fileName,bytes:bytes.length,prompt:{mode:'none'},folderId:'root'};
  await bound.startIntake(d.projectId||'',input,target);
  return {target,bound,input,upload:()=>bound.upload(d.projectId||'',requestId,Readable.from([bytes]))};
}
async function proposal(f,name='合成人物',look='日常') {return (await f.managed.imageProposal(f.project.id,name,look)).destination;}

test('Finder confirms an episode-local image target and refuses a newly inherited namesake before registration', async t => {
  const f = await fixture(t);
  const dir = f.projects.series;
  const series = dir.createSeries({ name: '合成剧', request_id: randomUUID() });
  const { project: episode } = dir.createEpisode(series.id, { season_id: null, expected_episode_no: 1, request_id: randomUUID() });
  const name = '合成同名人物';
  const stale = (await f.managed.imageProposal(episode.id, name, '日常')).destination;
  const context_token = f.assets.scoped.scope('series', series.id).context_token;
  await f.assets.scopedWrites.create('series', series.id, {
    request_id: randomUUID(), context_token, kind: 'character', name, on_shared: 'reject',
  });
  await assert.rejects(f.managed.imageProposal(episode.id, name, '日常'), { code: 'SHARED_ASSET_EXISTS' });
  await assert.rejects(f.managed.prepare(stale), { code: 'SHARED_ASSET_EXISTS' });
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM assets').get().n, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM creative_assets WHERE project_id=?').get(episode.id).n, 0);
});
async function withSyncHook(hook,run) {
  const open=fs.open,handles=[];
  fs.open=async function(file,...args) {
    const handle=await open.call(this,file,...args),sync=handle.sync;
    handles.push(handle);
    handle.sync=()=>hook(String(file),()=>sync.call(handle));
    return handle;
  };
  try {return await run();} finally {fs.open=open;assert.ok(handles.every(h=>h.fd===-1),'all owned file/directory descriptors must close');}
}

test('all four library kinds copy independent bytes, derive classification, persist private idempotent receipts, never probe',async t=>{
  const f=await fixture(t);
  for(const [kind,ext] of [['photo','png'],['video','mp4'],['music','wav'],['sfx','mp3']]) {
    await f.managed.createFolder(kind,{name:'一级'});await f.managed.createFolder(kind,{directory:'一级',name:'二级'});
    const d={kind,scope:'library',directory:'一级/二级'},selected=await start(f,d,{},'fixture.'+ext);
    const result=await selected.upload();assert.equal(result.status,'ready');assert.ok(result.assetId);
    const s=selected.bound.receipt('',selected.input.requestId),a=f.lib.asset(result.assetId);
    assert.equal(a.kind,kind);assert.equal(a.category,'一级');assert.equal(a.sub,'二级');assert.equal(a.review,0);
    assert.equal(s.hash,sha(png));assert.equal(s.published,path.join(selected.target.target,'fixture.'+ext));
    assert.deepEqual(await fs.readFile(a.path),png);
    const stat=await fs.stat(a.path);assert.notEqual(String(stat.ino),s.stageStat.ino);
    assert.deepEqual(await selected.bound.startIntake('',selected.input,selected.target),result);
    await assert.rejects(selected.bound.upload('',selected.input.requestId,Readable.from([png])),e=>e.code==='IMPORT_BUSY');
    await assert.rejects(selected.bound.startIntake('',{...selected.input,bytes:png.length+1},selected.target),e=>e.code==='REQUEST_ID_CONFLICT');
    const receiptStat=await fs.stat(f.managed.receipts.file(s.id));assert.equal(receiptStat.mode&0o077,0);
    const source=await selected.bound.verifiedSource('',result.assetId);assert.equal(source.path,a.path);
    assert.equal((await selected.bound.hash(source.path,source.identity)).hash,sha(png));
    await selected.bound.cleanupIntakeStage('',s.id);await assert.rejects(fs.access(s.stage),{code:'ENOENT'});
    assert.equal(selected.bound.receipt('',s.id).stageCleanup.complete,true);
    await fs.access(a.path);
  }
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM assets').get().n,4);
  const restarted=await new ManagedIntakeCatalog(f.options).init();
  for(const s of f.managed.receipts.list()) assert.equal(restarted.receipts.read(s.id).status,'ready');
});

test('flattened max-two-level choices include pending root; invalid paths, nonexistent categories, linked or public roots fail closed',async t=>{
  const f=await fixture(t);
  assert.deepEqual((await f.managed.choices('photo')).folders,[{id:'',name:'待确认',relativePath:''}]);
  await f.managed.createFolder('photo',{name:'甲'});await f.managed.createFolder('photo',{directory:'甲',name:'乙'});
  const base=path.join(f.options.directory,'system_picture');await fs.mkdir(path.join(base,'甲','乙','ignored'));
  assert.deepEqual((await f.managed.choices('photo')).folders.map(f=>f.relativePath),['','甲','甲/乙']);
  for(const directory of ['../escape','/absolute','a\\b','a//b','a/b/c','.hidden','a/..'])
    await assert.rejects(f.managed.prepare({kind:'photo',scope:'library',directory}),e=>e.code==='INVALID_DESTINATION');
  await assert.rejects(f.managed.createFolder('photo',{directory:'甲/乙',name:'丙'}),e=>e.code==='INVALID_DESTINATION');
  await assert.rejects(f.managed.prepare({kind:'photo',scope:'library',directory:'missing'}),e=>e.code==='TARGET_CHANGED');
  await assert.rejects(fs.access(path.join(base,'missing')),{code:'ENOENT'});
  await fs.mkdir(path.join(f.dir,'outside'));await fs.symlink(path.join(f.dir,'outside'),path.join(base,'linked'));
  await assert.rejects(f.managed.prepare({kind:'photo',scope:'library',directory:'linked'}),e=>e.code==='TARGET_CHANGED');
  await fs.chmod(base,0o755);
  await assert.rejects(f.managed.prepare({kind:'photo',scope:'library'}),e=>e.code==='TARGET_CHANGED');
});

test('original root type, registration, exact folder identity and ancestor proofs cannot be substituted or restored',async t=>{
  const f=await fixture(t),d={kind:'music',scope:'library'};
  const p=await prepared(f,d);
  f.db.prepare('UPDATE roots SET kind=? WHERE id=?').run('sfx',p.target.root.id);
  await assert.rejects(p.bound.current(''),e=>e.code==='TARGET_CHANGED');
  await assert.rejects(f.managed.prepare(d),e=>e.code==='TARGET_CHANGED');
  f.db.prepare('UPDATE roots SET kind=?,retired=1 WHERE id=?').run('music',p.target.root.id);
  await assert.rejects(f.managed.prepare(d),e=>e.code==='TARGET_RETIRED');
  assert.equal(f.db.prepare('SELECT retired FROM roots WHERE id=?').get(p.target.root.id).retired,1);
  f.db.prepare('UPDATE roots SET retired=0 WHERE id=?').run(p.target.root.id);
  await fs.rename(p.target.target,p.target.target+'-original');await fs.mkdir(p.target.target,{mode:0o700});
  await assert.rejects(p.bound.current(''),e=>e.code==='TARGET_CHANGED');
  await assert.rejects(p.bound.startIntake('',{requestId:randomUUID(),fileName:'x.wav',bytes:1},p.target),e=>e.code==='TARGET_CHANGED');
  const p2=await prepared(f,d);
  await fs.rename(f.options.directory,f.options.directory+'-original');await fs.mkdir(f.options.directory,{mode:0o700});
  await assert.rejects(p2.bound.current(''),e=>e.code==='TARGET_CHANGED'||e.code==='ENOENT');
});

test('overlapping registered roots of any type are refused without registering a second root',async t=>{
  const f=await fixture(t);await fs.mkdir(f.options.directory,{mode:0o700});
  await f.lib.addRoot(f.options.directory,'mixed');
  await assert.rejects(f.managed.prepare({kind:'photo',scope:'library'}),e=>e.code==='TARGET_CHANGED');
  assert.equal(f.lib.roots().length,1);
});

test('root retired during prepare is never implicitly restored by registration',async t=>{
  const f=await fixture(t),ensure=f.managed.ensureDirectory.bind(f.managed);let retired;
  f.managed.ensureDirectory=async(...args)=>{
    const proof=await ensure(...args);
    if(args[0]===path.join(f.options.directory,'system_video')) {
      const root=await f.lib.addRoot(args[0],'video');retired=root.id;f.db.prepare('UPDATE roots SET retired=1 WHERE id=?').run(root.id);
    }
    return proof;
  };
  await assert.rejects(f.managed.prepare({kind:'video',scope:'library'}),e=>e.code==='TARGET_RETIRED');
  assert.equal(f.db.prepare('SELECT retired FROM roots WHERE id=?').get(retired).retired,1);
});

test('duplicates expose held photo/audio candidates; reuse/import/rename/cancel never overwrite',async t=>{
  const f=await fixture(t);
  for(const [kind,ext] of [['photo','png'],['sfx','wav']]) {
    const d={kind,scope:'library'},first=await start(f,d,{},'same.'+ext),a=await first.upload();
    const second=await start(f,d,{},'same.'+ext,Buffer.concat([png,Buffer.from('different')])),dupe=await second.upload();
    assert.equal(dupe.status,'duplicate');assert.equal(dupe.candidates.length,1);
    assert.equal(dupe.candidates[0].mediaUrl,`/api/file-intake/media-imports/${second.input.requestId}/candidates/${dupe.candidates[0].id}/media`);
    const opened=await f.managed.openCandidate(second.input.requestId,dupe.candidates[0].id);
    try {assert.deepEqual(await opened.handle.readFile(),png);} finally {await f.media.release(opened.handle);}
    await assert.rejects(second.bound.resolve('',second.input.requestId,{choice:'overwrite'}),e=>e.code==='INVALID_CHOICE');
    const reused=await second.bound.resolve('',second.input.requestId,{choice:'reuse',candidateId:dupe.candidates[0].id});
    assert.equal(reused.assetId,a.assetId);assert.deepEqual(await fs.readFile(f.lib.asset(a.assetId).path),png);
    const third=await start(f,d,{},'same.'+ext),thirdDupe=await third.upload();assert.equal(thirdDupe.status,'duplicate');
    const imported=await third.bound.resolve('',third.input.requestId,{choice:'import'});assert.equal(imported.status,'ready');assert.notEqual(imported.assetId,a.assetId);
    const fourth=await start(f,d,{},'same.'+ext);await fourth.upload();
    const renamed=await fourth.bound.resolve('',fourth.input.requestId,{choice:'rename',fileName:'alternate.'+ext});assert.match(renamed.fileName,/^alternate_/);
    const fifth=await start(f,d,{},'same.'+ext);await fifth.upload();
    assert.equal((await fifth.bound.resolve('',fifth.input.requestId,{choice:'cancel'})).status,'cancelled');
    await assert.rejects(fifth.bound.upload('',fifth.input.requestId,Readable.from([png])),e=>e.code==='IMPORT_BUSY');
  }
});

test('candidate change of inode, bytes, registered root or classification invalidates original proof',async t=>{
  const f=await fixture(t),d={kind:'photo',scope:'library'},first=await start(f,d),ready=await first.upload();
  const duplicate=await start(f,d),dto=await duplicate.upload(),c=dto.candidates[0];
  f.db.prepare('UPDATE assets SET category=? WHERE id=?').run('external',ready.assetId);
  await assert.rejects(f.managed.openCandidate(duplicate.input.requestId,c.id),e=>e.code==='SOURCE_CHANGED');
  await assert.rejects(duplicate.bound.resolve('',duplicate.input.requestId,{choice:'reuse',candidateId:c.id}),e=>e.code==='MEDIA_CONFLICT');
  const changed=await start(f,d),next=await changed.upload(),file=f.lib.asset(ready.assetId).path;
  await fs.rename(file,file+'.original');await fs.writeFile(file,png);
  await assert.rejects(f.managed.openCandidate(changed.input.requestId,next.candidates[0].id),e=>e.code==='SOURCE_CHANGED');
});

test('project proposal is read-only, requires explicit IDs/revisions; same-batch new character/look IDs survive two preparations and commits',async t=>{
  const f=await fixture(t),result=await f.managed.imageProposal(f.project.id,'合成人物','日常'),d=result.destination;
  assert.deepEqual(Object.keys(result).sort(),['destination','message']);
  assert.deepEqual(d,{kind:'photo',scope:'project',projectId:f.project.id,characterId:null,characterRevision:null,lookId:null,lookRevision:null,
    newCharacter:true,newLook:true,characterName:'合成人物',lookName:'日常'});
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM creative_assets').get().n,0);
  await assert.rejects(f.managed.prepare({kind:'photo',scope:'project',projectId:f.project.id,characterName:'合成人物',lookName:'日常'}),e=>e.code==='IMAGE_PROPOSAL_REQUIRED');
  const sharedImages=new Map(),p1=await prepared(f,d,{sharedImages}),p2=await prepared(f,d,{sharedImages});
  assert.deepEqual(p1.target.imageIds,p2.target.imageIds);
  const first=await start(f,d,p1,'first.png'),second=await start(f,d,p2,'second.png',Buffer.concat([png,Buffer.from('2')]));
  // Concurrent streams may reach the serialized commit in either order. The
  // cover belongs to the first successful commit, not Promise.all's index.
  const readyOrder=[],write=f.managed.receipts.write.bind(f.managed.receipts);
  f.managed.receipts.write=(s,options)=>{const result=write(s,options);if(s.status==='ready') readyOrder.push(s.bindingId);return result;};
  let a,b;
  try {[a,b]=await Promise.all([first.upload(),second.upload()]);} finally {f.managed.receipts.write=write;}
  assert.equal(a.status,'ready');assert.equal(b.status,'ready');assert.equal(readyOrder.length,2);
  assert.equal(a.creativeAssetId,b.creativeAssetId);assert.equal(a.lookId,b.lookId);assert.notEqual(a.bindingId,b.bindingId);
  const character=f.assets.get(a.creativeAssetId);assert.equal(character.images.length,2);assert.equal(character.looks.length,1);
  assert.equal(character.default_look_id,a.lookId);assert.equal(character.looks[0].default_image_id,readyOrder[0]);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM creative_assets').get().n,1);
  assert.ok(f.lib.asset(a.assetId).path.includes(path.sep+'picture'+path.sep));
  await assert.rejects(first.bound.current(f.other.id),e=>e.code==='TARGET_CHANGED');
  const proof=await second.bound.verifiedSource(f.project.id,b.assetId);assert.equal(proof.path,f.lib.asset(b.assetId).path);
  const existing=await proposal(f);assert.equal(existing.characterId,a.creativeAssetId);assert.equal(existing.characterRevision,character.revision);assert.equal(existing.lookRevision,character.looks[0].revision);
  assert.equal(existing.newCharacter,false);assert.equal(existing.newLook,false);
});

test('existing project data and default cover survive append; own group revisions advance, external edits do not',async t=>{
  const f=await fixture(t),d=await proposal(f),seed=await start(f,d),initial=await seed.upload();
  let a=f.assets.get(initial.creativeAssetId);a.base_info='保留基础信息';a.performance_info='保留表演';a.details={custom:'保留'};
  a.looks[0].tags=['保留'];a.looks[0].description='保留造型';a.images[0].locks='保留图片锁定';
  await f.assets.save(a.id,a,a.revision);
  const existing=await proposal(f),sharedImages=new Map(),p1=await prepared(f,existing,{sharedImages}),p2=await prepared(f,existing,{sharedImages});
  const second=await start(f,existing,p1,'second.png',Buffer.concat([png,Buffer.from('two')])),third=await start(f,existing,p2,'third.png',Buffer.concat([png,Buffer.from('three')]));
  assert.equal((await second.upload()).status,'ready');
  a=f.assets.get(a.id);assert.equal(a.base_info,'保留基础信息');assert.equal(a.performance_info,'保留表演');assert.deepEqual(a.details,{custom:'保留'});
  assert.equal(a.looks[0].default_image_id,initial.bindingId);assert.deepEqual(a.looks[0].tags,['保留']);assert.equal(a.images[0].locks,'保留图片锁定');
  await f.assets.save(a.id,{...a,base_info:'外部编辑'},a.revision);
  await assert.rejects(third.upload(),e=>e.code==='IMAGE_TARGET_CONFLICT');
  assert.equal(f.assets.get(a.id).images.length,2);
});

test('concurrent foreign same-name character/look creation, archived target and stale revision never get claimed',async t=>{
  const f=await fixture(t),d=await proposal(f),p=await prepared(f,d),pending=await start(f,d,p);
  const foreign=await f.assets.create({project_id:f.project.id,kind:'character',name:d.characterName});
  await assert.rejects(pending.upload(),e=>e.code==='IMAGE_TARGET_CONFLICT');assert.equal(f.assets.get(foreign.id).images.length,0);
  const next=await proposal(f),p2=await prepared(f,next),copy=await start(f,next,p2);
  let a=f.assets.get(foreign.id);const look={id:randomUUID(),name:d.lookName,tags:[],description:'',default_image_id:null,archived_at:null};a.looks.push(look);a.default_look_id=look.id;
  await f.assets.save(a.id,a,a.revision);
  await assert.rejects(copy.upload(),e=>e.code==='IMAGE_TARGET_CONFLICT');
  const existing=await proposal(f),p3=await prepared(f,existing),last=await start(f,existing,p3);
  a=f.assets.get(foreign.id);f.assets.archive(a.id,true,a.revision);
  await assert.rejects(last.upload(),e=>e.code==='IMAGE_TARGET_CONFLICT');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM assets').get().n,0);
});

test('generation lock and late revision race reject atomically without partial media or creative binding',async t=>{
  const f=await fixture(t),d=await proposal(f),selected=await start(f,d);
  let locked=false;f.assets.generationLocks={assertWritable(){if(locked) throw Object.assign(Error('fixture generation active'),{code:'GENERATION_BUSY'});}};
  const original=f.assets.prepare;
  f.assets.prepare=async function(...args){const a=await original.apply(this,args);locked=true;return a;};
  await assert.rejects(selected.upload(),e=>e.code==='GENERATION_BUSY');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM assets').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM creative_assets').get().n,0);
  const raw=selected.bound.receipt('',selected.input.requestId);assert.equal(raw.status,'unknown');await fs.access(raw.published);
});

test('ProjectAssets write failure rolls back registration; UNKNOWN never name-claims or resends',async t=>{
  const f=await fixture(t),d=await proposal(f),selected=await start(f,d);
  const original=f.assets.write;f.assets.write=()=>{throw Error('fixture write failure');};
  await assert.rejects(selected.upload(),/fixture write failure/);f.assets.write=original;
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM assets').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM creative_assets').get().n,0);
  const raw=selected.bound.receipt('',selected.input.requestId);assert.equal(raw.status,'unknown');assert.ok(raw.commit);await fs.access(raw.published);
  const restarted=await new ManagedIntakeCatalog(f.options).init(),bound=restarted.bind(d,selected.target);
  assert.equal(bound.receipt('',selected.input.requestId).status,'unknown');
  await assert.rejects(bound.upload('',selected.input.requestId,Readable.from([png])),e=>e.code==='IMPORT_BUSY');
  await assert.rejects(bound.resolve('',selected.input.requestId,{choice:'import'}),e=>e.code==='IMPORT_BUSY');
  await assert.rejects(bound.verifiedSource('',raw.ids.mediaId),e=>e.code==='SOURCE_UNTRUSTED');
});

test('commit before final receipt loss recovers by persisted exact IDs, bound content and revision without recreating',async t=>{
  const f=await fixture(t),d=await proposal(f),selected=await start(f,d),write=f.managed.receipts.write.bind(f.managed.receipts);
  f.managed.receipts.write=(s,options)=>{if(['ready','unknown'].includes(s.status)) throw Error('fixture fsync interruption');return write(s,options);};
  await assert.rejects(selected.upload(),/fixture fsync interruption/);f.managed.receipts.write=write;
  const raw=selected.bound.receipt('',selected.input.requestId);assert.equal(raw.status,'committing');assert.ok(raw.commit);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM creative_image_bindings').get().n,1);
  const restarted=await new ManagedIntakeCatalog(f.options).init(),bound=restarted.bind(d,selected.target),recovered=bound.receipt('',raw.id);
  assert.equal(recovered.status,'ready');assert.equal(recovered.assetId,raw.ids.mediaId);assert.equal(recovered.creativeAssetId,raw.ids.characterId);assert.equal(recovered.bindingId,raw.ids.bindingId);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM assets').get().n,1);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM creative_image_bindings').get().n,1);
  assert.equal((await bound.verifiedSource('',recovered.assetId)).path,recovered.published);
});

test('committed receipt loss followed by an external revision stays UNKNOWN, never reclaims by name',async t=>{
  const f=await fixture(t),d=await proposal(f),selected=await start(f,d),write=f.managed.receipts.write.bind(f.managed.receipts);
  f.managed.receipts.write=(s,options)=>{if(['ready','unknown'].includes(s.status)) throw Error('fixture final journal lost');return write(s,options);};
  await assert.rejects(selected.upload(),/fixture final journal lost/);f.managed.receipts.write=write;
  const raw=selected.bound.receipt('',selected.input.requestId),a=f.assets.get(raw.ids.characterId);
  await f.assets.save(a.id,{...a,base_info:'external revision'},a.revision);
  const restarted=await new ManagedIntakeCatalog(f.options).init();
  assert.equal(restarted.bind(d,selected.target).receipt('',raw.id).status,'unknown');
  assert.equal(f.assets.get(a.id).images.length,1);
});

test('held registration descriptor rejects substitution during async ProjectAssets preparation',async t=>{
  const f=await fixture(t),d=await proposal(f),selected=await start(f,d),original=f.assets.prepare;
  f.assets.prepare=async function(...args){
    const prepared=await original.apply(this,args),raw=selected.bound.receipt('',selected.input.requestId);
    await fs.rename(raw.published,raw.published+'.original');await fs.copyFile(raw.published+'.original',raw.published);return prepared;
  };
  await assert.rejects(selected.upload(),e=>e.code==='SOURCE_CHANGED');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM assets').get().n,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM creative_assets').get().n,0);
});

test('waiting restart stays inert; receive length errors publish nothing; receipt links and invalid destinations rejected',async t=>{
  const f=await fixture(t),d={kind:'sfx',scope:'library'},selected=await start(f,d,{},'fixture.wav');
  const restarted=await new ManagedIntakeCatalog(f.options).init(),bound=restarted.bind(d,selected.target);
  assert.equal(bound.receipt('',selected.input.requestId).status,'waiting');
  await assert.rejects(bound.upload('',selected.input.requestId,Readable.from([png])),e=>e.code==='IMPORT_BUSY');
  assert.equal((await bound.resolve('',selected.input.requestId,{choice:'cancel'})).status,'cancelled');
  const next=await start(f,d,{},'next.wav');
  await assert.rejects(next.bound.upload('',next.input.requestId,Readable.from([Buffer.from('short')])),e=>e.code==='INVALID_LENGTH');
  assert.equal(next.bound.receipt('',next.input.requestId).status,'failed');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM assets').get().n,0);
  for(const invalid of [{kind:'music',scope:'project',projectId:f.project.id},{kind:'video',scope:'project',projectId:f.project.id},{kind:'photo',scope:'library',projectId:f.project.id}])
    await assert.rejects(f.managed.prepare(invalid),e=>e.code==='INVALID_DESTINATION');
  const photo=await prepared(f,{kind:'photo',scope:'library'});
  await assert.rejects(photo.bound.startIntake('',{requestId:randomUUID(),fileName:'wrong.mp3',bytes:1},photo.target),e=>e.code==='INVALID_MEDIA');
  assert.throws(()=>f.managed.bind({...d,directory:'different'},selected.target),e=>e.code==='TARGET_CHANGED');
  const receipt=f.managed.receipts.file(next.input.requestId);await fs.rename(receipt,receipt+'.saved');await fs.symlink(receipt+'.saved',receipt);
  assert.throws(()=>next.bound.receipt('',next.input.requestId),e=>e.code==='ELOOP');
  await fs.unlink(receipt);await fs.rename(receipt+'.saved',receipt);
});

test('prepared root and receipt directories must remain private; readonly and close guards refuse further work',async t=>{
  const f=await fixture(t),d={kind:'photo',scope:'library'},p=await prepared(f,d);
  await fs.chmod(p.target.base,0o755);await assert.rejects(p.bound.current(''),e=>e.code==='TARGET_CHANGED');await fs.chmod(p.target.base,0o700);
  const before=process.env.MEDIA_READONLY_FILES;process.env.MEDIA_READONLY_FILES='1';
  try {await assert.rejects(p.bound.current(''),e=>e.code==='READONLY_FILES');} finally {if(before===undefined) delete process.env.MEDIA_READONLY_FILES;else process.env.MEDIA_READONLY_FILES=before;}
  f.media.closing=true;await assert.rejects(p.bound.current(''),e=>e.code==='IMPORT_BUSY');f.media.closing=false;
  const selected=await start(f,d);await selected.upload();
  await fs.chmod(f.managed.receipts.base,0o755);
  assert.throws(()=>selected.bound.receipt('',selected.input.requestId),e=>e.code==='TARGET_CHANGED');
  await fs.chmod(f.managed.receipts.base,0o700);
});

async function settled(intake) {
  const deadline=Date.now()+10000;
  while(intake.work || intake.status().activeCount) {
    if(Date.now()>deadline) throw Error('fixture intake did not settle');
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  if(intake.lastError) throw intake.lastError;
}

test('parent FileIntake context dispatch accepts mixed generic destinations and nested shared project image proposals',async t=>{
  const f=await fixture(t),intake=await new FileIntake({dataDir:f.dataDir,catalog:f.catalog,projects:f.projects,generic:f.managed}).init();
  t.after(()=>intake.close());
  const image=await proposal(f),files=[],targets=[];
  for(const [name,d] of [['library.png',{kind:'photo',scope:'library'}],['movie.mp4',{kind:'video',scope:'library'}],
    ['music.wav',{kind:'music',scope:'library'}],['sound.wav',{kind:'sfx',scope:'library'}],
    ['actor-first.png',{kind:'photo',scope:'project',projectId:f.project.id,imageProposal:image}],['actor-second.png',{kind:'photo',scope:'project',projectId:f.project.id,imageProposal:image}]]) {
    const file=path.join(f.dir,name);await fs.writeFile(file,Buffer.concat([png,Buffer.from(name)]));files.push(file);targets.push(d);
  }
  const h=await intake.receipts.handoff(files),input={version:2,requestId:randomUUID(),mode:'copy',fileIds:h.files.map(f=>f.id),targets:h.files.map((f,i)=>({fileId:f.id,destination:targets[i]}))};
  const batch=await intake.confirm(h.id,input);await settled(intake);
  const result=intake.dto(intake.batch(batch.id));assert.equal(result.status,'completed');assert.deepEqual(result.items.map(i=>i.status),Array(6).fill('ready'));
  assert.equal(result.items[4].creativeAssetId,result.items[5].creativeAssetId);assert.equal(result.items[4].lookId,result.items[5].lookId);
  assert.equal(f.assets.get(result.items[4].creativeAssetId).images.length,2);
  for(const item of result.items) assert.equal(item.error,undefined);
  for(const file of files) await fs.access(file);
});

test('parent move removes only its disposable original after durable generic registration and verified independent copy',async t=>{
  const f=await fixture(t),file=path.join(f.dir,'original.png');await fs.writeFile(file,png);let calls=0;
  const intake=await new FileIntake({dataDir:f.dataDir,catalog:f.catalog,projects:f.projects,generic:f.managed,trash:async(source,expected)=>{
    calls++;assert.equal(source,file);assert.equal(expected.sha256,sha(png));
    assert.equal(f.managed.receipts.list()[0].status,'ready');
    const destination=path.join(f.dir,'owned-fixture-trash.png');await fs.rename(source,destination);return destination;
  }}).init();t.after(()=>intake.close());
  const h=await intake.receipts.handoff([file]),d={kind:'photo',scope:'library'},batch=await intake.confirm(h.id,{version:2,requestId:randomUUID(),mode:'move',fileIds:[h.files[0].id],targets:[{fileId:h.files[0].id,destination:d}]});
  await settled(intake);const item=intake.batch(batch.id).items[0];assert.equal(item.status,'ready');assert.equal(item.removal,'complete');assert.equal(calls,1);
  assert.deepEqual(await fs.readFile(f.lib.asset(item.assetId).path),png);await assert.rejects(fs.access(file),{code:'ENOENT'});
});

test('formal file and all pinned directory entries sync leaf-first before committing library or project images',async t=>{
  for(const scope of ['library','project']) await t.test(scope,async t=>{
    const f=await fixture(t),d=scope==='project'?await proposal(f):{kind:'photo',scope},selected=await start(f,d),events=[];
    const expected=[path.join(selected.target.target,'test.png'),...[...new Set(selected.target.proofs.map(p=>p.path))].reverse()];
    const write=f.managed.receipts.write.bind(f.managed.receipts);
    f.managed.receipts.write=(s,options)=>{
      if(['committing','ready'].includes(s.status)) {
        assert.deepEqual(events.filter(file=>expected.includes(file)),expected);
        assert.equal(s.durability.version,1);assert.equal(s.durability.path,s.published);assert.equal(s.durability.hash,sha(png));
      }
      return write(s,options);
    };
    try {
      await withSyncHook(async(file,sync)=>{await sync();events.push(file);},async()=>assert.equal((await selected.upload()).status,'ready'));
    } finally {f.managed.receipts.write=write;}
    const s=selected.bound.receipt('',selected.input.requestId);
    assert.deepEqual(s.durability.identity,s.resultIdentity);
    await fs.access(s.stage);
  });
});

test('EIO at formal file, target or created ancestor sync retains source/stage and UNKNOWN across restart',async t=>{
  for(const failure of ['file','target','personal_item','anchor','project']) await t.test(failure,async t=>{
    const f=await fixture(t),d=failure==='project'?await proposal(f):{kind:'photo',scope:'library'};
    const file=path.join(f.dir,'original.png');await fs.writeFile(file,png);let trashCalls=0,failedPath;
    const intake=await new FileIntake({dataDir:f.dataDir,catalog:f.catalog,projects:f.projects,generic:f.managed,trash:async()=>{trashCalls++;assert.fail('unsynced copy must retain its source');}}).init();
    t.after(()=>intake.close());
    const h=await intake.receipts.handoff([file]);
    let batch;
    await withSyncHook(async(file,sync)=>{
      const s=f.managed.receipts.list()[0];
      const expected=s&&(failure==='file'?s.published:failure==='personal_item'?f.managed.directory:failure==='anchor'?f.managed.anchor.path:s.target.target);
      if(file===expected) {failedPath=file;throw Object.assign(Error('fixture formal sync EIO'),{code:'EIO'});}
      return sync();
    },async()=>{
      batch=await intake.confirm(h.id,{version:2,requestId:randomUUID(),mode:'move',fileIds:[h.files[0].id],targets:[{fileId:h.files[0].id,destination:d}]});
      await settled(intake);
    });
    assert.ok(failedPath);assert.equal(trashCalls,0);assert.equal(intake.batch(batch.id).items[0].status,'unknown');
    const raw=f.managed.receipts.list()[0];assert.equal(raw.status,'unknown');assert.equal(raw.durability,undefined);assert.equal(raw.commit,undefined);assert.equal(raw.stageCleanup,undefined);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM assets').get().n,0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM creative_assets').get().n,0);
    assert.deepEqual(await fs.readFile(file),png);assert.deepEqual(await fs.readFile(raw.stage),png);await fs.access(raw.published);
    const restarted=await new ManagedIntakeCatalog(f.options).init(),bound=restarted.bind(raw.target.destination,raw.target);
    assert.equal(bound.receipt('',raw.id).status,'unknown');
    await assert.rejects(bound.resolve('',raw.id,{choice:'import'}),e=>e.code==='IMPORT_BUSY');
    await assert.rejects(bound.verifiedSource('',raw.ids.mediaId),e=>e.code==='SOURCE_UNTRUSTED');
    await fs.access(raw.stage);
  });
});

test('file or ancestor substitution during durability barriers refuses registration and preserves stage',async t=>{
  for(const change of ['file','directory']) await t.test(change,async t=>{
    const f=await fixture(t),d={kind:'photo',scope:'library'},selected=await start(f,d);let replaced=false;
    await withSyncHook(async(file,sync)=>{
      await sync();
      const raw=selected.bound.receipt('',selected.input.requestId);
      if(!replaced && file===(change==='file'?raw.published:selected.target.target)) {
        replaced=true;await fs.rename(file,file+'.original');
        if(change==='file') await fs.writeFile(file,png);else await fs.mkdir(file,{mode:0o700});
      }
    },async()=>await assert.rejects(selected.upload(),e=>['SOURCE_CHANGED','TARGET_CHANGED'].includes(e.code)));
    assert.equal(replaced,true);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM assets').get().n,0);
    const raw=selected.bound.receipt('',selected.input.requestId);assert.equal(raw.status,'unknown');assert.equal(raw.durability,undefined);await fs.access(raw.stage);
  });
});

test('legacy ready and commit journals without durability proof never gain cleanup or source-removal authority',async t=>{
  for(const status of ['ready','committing']) await t.test(status,async t=>{
    const f=await fixture(t),d={kind:'photo',scope:'library'},selected=await start(f,d),result=await selected.upload();
    const raw=selected.bound.receipt('',selected.input.requestId);delete raw.durability;raw.status=status;f.managed.persist(raw);
    if(status==='ready') await assert.rejects(selected.bound.cleanupIntakeStage('',raw.id),e=>e.code==='SOURCE_UNTRUSTED');
    const restarted=await new ManagedIntakeCatalog(f.options).init(),bound=restarted.bind(d,selected.target);
    assert.equal(bound.receipt('',raw.id).status,status==='ready'?'ready':'unknown');
    await assert.rejects(bound.verifiedSource('',result.assetId),e=>e.code==='SOURCE_UNTRUSTED');
    assert.equal(bound.receipt('',raw.id).durability,undefined);await fs.access(raw.stage);await fs.access(raw.published);
  });
});

test('parent move retains original and stage if a ready journal lacks its matching durability proof',async t=>{
  const f=await fixture(t),file=path.join(f.dir,'original.png');await fs.writeFile(file,png);let trashCalls=0;
  const intake=await new FileIntake({dataDir:f.dataDir,catalog:f.catalog,projects:f.projects,generic:f.managed,trash:async()=>{trashCalls++;assert.fail('legacy ready must not authorize trash');}}).init();
  t.after(()=>intake.close());
  const write=f.managed.receipts.write.bind(f.managed.receipts);
  f.managed.receipts.write=(s,options)=>{if(s.status==='ready') delete s.durability;return write(s,options);};
  try {
    const h=await intake.receipts.handoff([file]),d={kind:'photo',scope:'library'};
    const batch=await intake.confirm(h.id,{version:2,requestId:randomUUID(),mode:'move',fileIds:[h.files[0].id],targets:[{fileId:h.files[0].id,destination:d}]});
    await settled(intake);
    const item=intake.batch(batch.id).items[0];assert.equal(item.status,'source_retained');assert.equal(item.removal,undefined);assert.equal(trashCalls,0);
    const raw=f.managed.receipts.list()[0];assert.equal(raw.status,'ready');assert.equal(raw.stageCleanup,undefined);
    assert.deepEqual(await fs.readFile(file),png);await fs.access(raw.stage);
  } finally {f.managed.receipts.write=write;}
});

test('same journal dataDir with another actual SQLite library never reads, rewrites, recovers or previews foreign requests',async t=>{
  const f=await fixture(t,{libraryId:'fixture-library-A'}),d={kind:'photo',scope:'library'};
  const ready=await start(f,d),readyDTO=await ready.upload(),duplicate=await start(f,d),duplicateDTO=await duplicate.upload();
  const waiting=await start(f,d,{},'waiting.png'),projectDestination=await proposal(f),committing=await start(f,projectDestination,{},'actor.png');
  const write=f.managed.receipts.write.bind(f.managed.receipts);
  f.managed.receipts.write=(s,options)=>{
    if(s.id===committing.input.requestId && ['ready','unknown'].includes(s.status)) throw Error('fixture final journal lost');
    return write(s,options);
  };
  try {await assert.rejects(committing.upload(),/fixture final journal lost/);} finally {f.managed.receipts.write=write;}
  const rows=[ready,duplicate,waiting,committing].map(item=>item.bound.receipt('',item.input.requestId));
  assert.deepEqual(rows.map(s=>s.status),['ready','duplicate','waiting','committing']);
  for(const row of rows) {assert.equal(row.libraryId,'fixture-library-A');assert.equal(row.target.libraryId,'fixture-library-A');}
  const snapshots=await Promise.all(rows.map(async s=>({id:s.id,bytes:await fs.readFile(f.managed.receipts.file(s.id))})));
  // Clone the fixture DB so roots, identities and committed bindings all match.
  // The actual-library ID must reject it even when those weaker proofs match.
  const otherData=path.join(f.dir,'other-fixture-library');await fs.mkdir(otherData);
  await f.db.backup(path.join(otherData,'library.sqlite'));
  const otherLib=await new Library(otherData,{directoryClassification:true}).init();otherLib.enqueue=()=>{};
  try {
    const otherAssets=new ProjectAssets(otherLib).init(),otherCatalog={lib:otherLib,db:otherLib.db,media:f.media};
    const foreign=new ManagedIntakeCatalog({...f.options,catalog:otherCatalog,assets:otherAssets,libraryId:'fixture-library-B'});
    const recover=foreign.recover.bind(foreign);let recoveries=0;
    foreign.recover=async()=>{recoveries++;throw Error('foreign recovery must not run');};
    assert.equal(await foreign.init(),foreign);assert.equal(foreign.initializationError,undefined);assert.equal(recoveries,0);assert.equal(foreign.completed.size,0);
    foreign.recover=recover;
    assert.throws(()=>foreign.bind(d,ready.target),e=>e.code==='LOCAL_INSTANCE_CHANGED');
    await assert.rejects(foreign.current(ready.target),e=>e.code==='LOCAL_INSTANCE_CHANGED');
    for(const row of rows) {
      assert.throws(()=>foreign.read(null,row.id),e=>e.code==='LOCAL_INSTANCE_CHANGED');
      assert.throws(()=>foreign.receiptDTO(row),e=>e.code==='LOCAL_INSTANCE_CHANGED');
      assert.throws(()=>foreign.persist(row),e=>e.code==='LOCAL_INSTANCE_CHANGED');
    }
    await assert.rejects(foreign.recover(rows[3]),e=>e.code==='LOCAL_INSTANCE_CHANGED');
    await assert.rejects(foreign.openCandidate(duplicate.input.requestId,duplicateDTO.candidates[0].id),e=>e.code==='LOCAL_INSTANCE_CHANGED');
    await assert.rejects(foreign.verifiedSource(ready.target,readyDTO.assetId),e=>e.code==='LOCAL_INSTANCE_CHANGED');
    assert.equal(foreign.groupOwns(committing.target.requestGroupId,otherAssets.get(rows[3].ids.characterId)),false);
    const ownTarget=await foreign.prepare(d),ownBound=foreign.bind(d,ownTarget);assert.equal(ownTarget.libraryId,'fixture-library-B');
    await assert.rejects(ownBound.startIntake('',waiting.input,ownTarget),e=>e.code==='LOCAL_INSTANCE_CHANGED');
    await assert.rejects(ownBound.verifiedSource('',readyDTO.assetId),e=>e.code==='SOURCE_UNTRUSTED');
    assert.throws(()=>foreign.persist({...rows[0],libraryId:'fixture-library-B',target:ownTarget}),e=>e.code==='LOCAL_INSTANCE_CHANGED');
    const ownId=randomUUID(),ownInput={requestId:ownId,fileName:'own.png',bytes:png.length};
    await ownBound.startIntake('',ownInput,ownTarget);assert.equal(ownBound.receipt('',ownId).libraryId,'fixture-library-B');
    assert.equal(ownBound.receipt('',ownId).target.libraryId,'fixture-library-B');
    assert.throws(()=>f.managed.read(null,ownId),e=>e.code==='LOCAL_INSTANCE_CHANGED');
    assert.equal(f.media.handles.size,0);
    for(const snapshot of snapshots) assert.deepEqual(await fs.readFile(f.managed.receipts.file(snapshot.id)),snapshot.bytes);
  } finally {otherLib.db.close();}
  const originalLibrary=await new ManagedIntakeCatalog(f.options).init();assert.equal(originalLibrary.initializationError,undefined);
  assert.equal(originalLibrary.bind(projectDestination,committing.target).receipt('',committing.input.requestId).status,'ready');
});

test('path-only legacy journal cannot acquire an actual library identity or be silently rewritten',async t=>{
  const f=await fixture(t),d={kind:'photo',scope:'library'},selected=await start(f,d);
  assert.equal(selected.target.libraryId,f.dataDir);assert.equal(selected.bound.receipt('',selected.input.requestId).libraryId,f.dataDir);
  const original=selected.bound.receipt('',selected.input.requestId),legacy=structuredClone(original);
  delete legacy.libraryId;delete legacy.target.libraryId;f.managed.receipts.write(legacy);
  const file=f.managed.receipts.file(legacy.id),before=await fs.readFile(file),restarted=await new ManagedIntakeCatalog(f.options).init();
  assert.equal(restarted.initializationError,undefined);assert.equal(restarted.completed.size,0);
  assert.throws(()=>restarted.read(null,legacy.id),e=>e.code==='LOCAL_INSTANCE_CHANGED');
  assert.throws(()=>restarted.persist(original),e=>e.code==='LOCAL_INSTANCE_CHANGED');
  await assert.rejects(restarted.bind(d,selected.target).startIntake('',selected.input,selected.target),e=>e.code==='LOCAL_INSTANCE_CHANGED');
  assert.deepEqual(await fs.readFile(file),before);
});

test('corrupt private journal exposes initializationError while the rest of the disposable library remains usable',async t=>{
  const f=await fixture(t),d={kind:'photo',scope:'library'},selected=await start(f,d),raw=selected.bound.receipt('',selected.input.requestId);
  const file=f.managed.receipts.file(raw.id),before=await fs.readFile(file);await fs.writeFile(file,'{fixture-corrupt');
  try {
    const isolated=new ManagedIntakeCatalog(f.options);assert.equal(await isolated.init(),isolated);
    const failure=isolated.initializationError;assert.equal(failure.code,'INTAKE_STORAGE_UNAVAILABLE');assert.equal(failure.status,503);assert.ok(failure.cause);
    assert.equal(isolated.completed.size,0);assert.equal(f.projects.list().length,2);
    await assert.rejects(isolated.prepare(d),e=>e===failure);
    await assert.rejects(isolated.choices('photo'),e=>e===failure);
    await assert.rejects(isolated.createFolder('photo',{name:'not-created'}),e=>e===failure);
    await assert.rejects(isolated.imageProposal(f.project.id,'人物','造型'),e=>e===failure);
    await assert.rejects(isolated.openCandidate(raw.id,randomUUID()),e=>e===failure);
    await assert.rejects(isolated.recover(raw),e=>e===failure);
    await assert.rejects(isolated.hash(path.join(f.dir,'not-opened')),e=>e===failure);
    assert.throws(()=>isolated.bind(d,selected.target),e=>e===failure);
    assert.throws(()=>isolated.read(null,raw.id),e=>e===failure);
    assert.throws(()=>isolated.persist(raw),e=>e===failure);
    assert.equal(await fs.readFile(file,'utf8'),'{fixture-corrupt');assert.equal(f.media.handles.size,0);
    await assert.rejects(fs.access(path.join(selected.target.base,'not-created')),{code:'ENOENT'});
  } finally {await fs.writeFile(file,before);}
});

test('journal file or directory permission failure is isolated and retains the original receipt unchanged',async t=>{
  const f=await fixture(t),d={kind:'photo',scope:'library'},selected=await start(f,d),file=f.managed.receipts.file(selected.input.requestId),before=await fs.readFile(file);
  for(const [target,mode] of [[file,0o644],[f.managed.receipts.base,0o755]]) {
    await fs.chmod(target,mode);
    try {
      const isolated=await new ManagedIntakeCatalog(f.options).init();assert.equal(isolated.initializationError?.code,'INTAKE_STORAGE_UNAVAILABLE');
      await assert.rejects(isolated.prepare(d),e=>e===isolated.initializationError);
      assert.equal(f.db.prepare('SELECT COUNT(*) n FROM media_projects').get().n,3);
      assert.deepEqual(await fs.readFile(file),before);assert.equal((await fs.stat(target)).mode&0o777,mode);
    } finally {await fs.chmod(target,target===file?0o600:0o700);}
  }
});

test('parent move with raw.reused retains its disposable original and never invokes trash',async t=>{
  const f=await fixture(t),d={kind:'photo',scope:'library'},seed=await start(f,d),existing=await seed.upload();
  const file=path.join(f.dir,'test.png');await fs.writeFile(file,png);let trashed=0;
  const intake=await new FileIntake({dataDir:f.dataDir,catalog:f.catalog,projects:f.projects,generic:f.managed,trash:async()=>{trashed++;assert.fail('reused source must be retained');}}).init();
  t.after(()=>intake.close());
  const h=await intake.receipts.handoff([file]),batch=await intake.confirm(h.id,{version:2,requestId:randomUUID(),mode:'move',fileIds:[h.files[0].id],targets:[{fileId:h.files[0].id,destination:d}]});
  await settled(intake);const item=intake.batch(batch.id).items[0];assert.equal(item.status,'duplicate');
  await intake.resolve(batch.id,item.id,{choice:'reuse',candidateId:item.candidates[0].id});
  assert.equal(item.status,'source_retained');assert.equal(item.assetId,existing.assetId);assert.equal(item.removal,undefined);
  assert.equal(f.managed.read(null,item.requestId).reused,true);assert.equal(trashed,0);assert.deepEqual(await fs.readFile(file),png);
  assert.deepEqual(await fs.readFile(f.lib.asset(existing.assetId).path),png);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM assets').get().n,1);
});

test('routing options do not create roots, and scene/prop intake binds ordered files to the exact active asset revision',async t=>{
  const f=await fixture(t);
  f.catalog.project=id=>f.projects.get(id);
  f.catalog.folders={rows:()=>[]};
  f.catalog.finalFolder={roles:async()=>({revision:0,rejectFolderId:null,finalFolderId:null,finalState:'not_created',finalErrorCode:null})};
  const intake=await new FileIntake({dataDir:f.dataDir,catalog:f.catalog,projects:f.projects,generic:f.managed}).init();
  t.after(()=>intake.close());
  const scene=await f.assets.create({project_id:f.project.id,kind:'scene',name:'场景甲'});
  const prop=await f.assets.create({project_id:f.project.id,kind:'prop',name:'道具乙'});
  const old=await f.assets.create({project_id:f.project.id,kind:'scene',name:'归档资产'});
  f.assets.archive(old.id,true,old.revision);
  const opts=await intake.routingOptions(),project=opts.projects.find(p=>p.id===f.project.id);
  assert.deepEqual(opts.photoCategories,[{id:'',name:'待确认',relativePath:''}]);
  assert.equal(f.lib.allRoots().length,0);
  await assert.rejects(fs.access(f.options.directory),{code:'ENOENT'});
  assert.deepEqual(new Set(project.assets.map(a=>a.id)),new Set([scene.id,prop.id]));
  assert.deepEqual(project.assets.find(a=>a.id===scene.id),{id:scene.id,name:scene.name,revision:scene.revision,kind:'scene',looks:[],defaultLookId:null});

  const input=async (assets,postfix='')=>{
    const files=await Promise.all(assets.map(async(_,i)=>{
      const file=path.join(f.dir,'image-'+i+postfix+'.png');await fs.writeFile(file,Buffer.concat([png,Buffer.from(file)]));return file;
    }));
    const h=await intake.receipts.handoff(files);
    return {h,files,args:{version:2,mode:'copy',requestId:randomUUID(),fileIds:h.files.map(f=>f.id),targets:h.files.map((f,i)=>({
      fileId:f.id,nameMode:'standard',destination:{kind:'photo',scope:'project',projectId:assets[i].project_id,assetKind:assets[i].kind,assetId:assets[i].id,assetRevision:assets[i].revision},
    }))}};
  };
  const batch=await input([scene,scene,prop]);
  const preview=await intake.namePreview(batch.h.id,batch.args);
  assert.deepEqual(preview.items.map(i=>i.proposedFileName),['场景甲_001.png','场景甲_002.png','道具乙_001.png']);
  await assert.rejects(fs.access(f.options.directory),{code:'ENOENT'});
  assert.equal(f.assets.get(scene.id).images.length,0);
  const accepted=await intake.confirm(batch.h.id,batch.args);
  assert.deepEqual(accepted.items.map(i=>i.plannedFileName),preview.items.map(i=>i.proposedFileName));
  await settled(intake);
  const result=intake.dto(intake.batch(accepted.id));
  assert.equal(result.status,'completed');
  assert.deepEqual(result.items.map(i=>i.resultFileName),preview.items.map(i=>i.proposedFileName));
  for(const item of intake.batch(accepted.id).items){
    assert.equal(item.error,undefined);
    assert.equal(f.managed.receipts.read(item.requestId).stageCleanup?.complete,true);
  }
  const after=f.assets.get(scene.id);
  assert.equal(after.default_image_id,result.items[0].bindingId);
  assert.deepEqual(after.images.map(i=>i.look_id),[null,null]);
  assert.equal(f.assets.get(prop.id).default_image_id,result.items[2].bindingId);
  assert.equal(f.assets.get(prop.id).images.length,1);
  for(const file of batch.files)await fs.access(file);

  const stale=await input([after],'stale');
  await f.assets.save(scene.id,{...after,base_info:'其他会话的最新编辑'},after.revision);
  await assert.rejects(intake.confirm(stale.h.id,stale.args),{code:'IMAGE_TARGET_CONFLICT',accepted:false});
  assert.equal(f.assets.get(scene.id).images.length,2);
  const fresh=await input([f.assets.get(scene.id)],'fresh');
  const more=await intake.confirm(fresh.h.id,fresh.args);await settled(intake);
  assert.equal(intake.dto(intake.batch(more.id)).items[0].resultFileName,'场景甲_003.png');
  assert.equal(f.assets.get(scene.id).default_image_id,result.items[0].bindingId);
});

test('moving scene and prop photos verifies the exact active binding without a look',async t=>{
  const f=await fixture(t),removals=[];
  const intake=await new FileIntake({
    dataDir:f.dataDir,catalog:f.catalog,projects:f.projects,generic:f.managed,
    async trash(file,expected){
      const target=file+'.owned-trash';
      removals.push({file,expected});
      await fs.rename(file,target);
      return target;
    },
  }).init();
  t.after(()=>intake.close());
  const assets=[];
  for(const [kind,name] of [['scene','场景甲'],['prop','道具乙']]){
    assets.push(await f.assets.create({project_id:f.project.id,kind,name}));
  }
  const files=assets.map(a=>path.join(f.dir,a.kind+'.png'));
  const contents=assets.map(a=>Buffer.concat([png,Buffer.from(a.name)]));
  await Promise.all(files.map((file,i)=>fs.writeFile(file,contents[i])));
  const handoff=await intake.receipts.handoff(files);
  const accepted=await intake.confirm(handoff.id,{
    version:2,mode:'move',requestId:randomUUID(),fileIds:handoff.files.map(f=>f.id),
    targets:handoff.files.map((file,i)=>({
      fileId:file.id,destination:{kind:'photo',scope:'project',projectId:f.project.id,
        assetKind:assets[i].kind,assetId:assets[i].id,assetRevision:assets[i].revision},
    })),
  });
  await settled(intake);
  const result=intake.batch(accepted.id);
  assert.equal(result.status,'completed',JSON.stringify(result.items.map(i=>i.error)));
  assert.deepEqual(removals.map(r=>r.file),files);
  for(const [i,item] of result.items.entries()){
    const receipt=f.managed.receipts.read(item.requestId);
    assert.equal(item.status,'ready',item.error);
    assert.equal(item.removal,'complete');
    assert.equal(receipt.stageCleanup?.complete,true);
    const [{look_id,media_asset_id}]=f.assets.get(assets[i].id).images;
    assert.equal(look_id,null);
    assert.equal(media_asset_id,item.assetId);
    assert.deepEqual(await fs.readFile(receipt.resultPath),contents[i]);
    assert.deepEqual(await fs.readFile(files[i]+'.owned-trash'),contents[i]);
    await assert.rejects(fs.access(files[i]),{code:'ENOENT'});
    f.lib.db.prepare('UPDATE creative_image_bindings SET archived_at=? WHERE id=?').run(Date.now(),item.bindingId);
    await assert.rejects(f.managed.verifiedSource(item.target,item.assetId),{code:'SOURCE_UNTRUSTED'});
  }
});

test('archiving a project image binding after the removal plan retains the original',async t=>{
  const f=await fixture(t);
  let trashCalls=0,archived=false;
  const intake=await new FileIntake({
    dataDir:f.dataDir,catalog:f.catalog,projects:f.projects,generic:f.managed,
    async trash(file){
      trashCalls++;
      const target=file+'.owned-trash';
      await fs.rename(file,target);
      return target;
    },
  }).init();
  t.after(()=>intake.close());
  const scene=await f.assets.create({project_id:f.project.id,kind:'scene',name:'场景甲'});
  const file=path.join(f.dir,'scene.png');
  await fs.writeFile(file,png);
  const save=intake.save.bind(intake);
  intake.save=async (batch,options)=>{
    await save(batch,options);
    const [item]=batch.items;
    if(archived||item.removal!=='planned')return;
    assert.equal((await intake.receipts.read('batches',batch.id)).items[0].removal,'planned');
    const asset=f.assets.get(scene.id);
    asset.default_image_id=null;
    asset.images.find(b=>b.id===item.bindingId).archived_at=Date.now();
    await f.assets.save(asset.id,asset,asset.revision);
    archived=true;
  };
  const handoff=await intake.receipts.handoff([file]),fileId=handoff.files[0].id;
  const accepted=await intake.confirm(handoff.id,{
    version:2,mode:'move',requestId:randomUUID(),fileIds:[fileId],
    targets:[{fileId,destination:{kind:'photo',scope:'project',projectId:f.project.id,
      assetKind:'scene',assetId:scene.id,assetRevision:scene.revision}}],
  });
  await settled(intake);
  const stored=await intake.receipts.read('batches',accepted.id);
  const [item]=stored.items;
  assert.equal(archived,true);
  assert.equal(trashCalls,0);
  assert.equal(item.status,'source_retained');
  assert.equal(item.code,'SOURCE_UNTRUSTED');
  assert.equal(item.removal,undefined);
  assert.equal(intake.dto(intake.batch(accepted.id)).canAcknowledge,true);
  assert.deepEqual(await fs.readFile(file),png);
  assert.deepEqual(await fs.readFile(f.managed.receipts.read(item.requestId).resultPath),png);
});
