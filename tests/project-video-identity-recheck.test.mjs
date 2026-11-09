import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {Library} from '../server/library.mjs';
import {Projects} from '../server/projects.mjs';
import {ProjectAssets} from '../server/project-assets/store.mjs';
import {StoryboardDatabase} from '../server/storyboard/database.mjs';
import {createStoryboardVideo} from '../server/storyboard-video/index.mjs';
import {ProjectVideos} from '../server/project-videos/store.mjs';
import {canonical} from '../server/project-assets/model.mjs';
import {syntheticSource} from './helpers/storyboard-fixture.mjs';

const stamp = s => ({dev:String(s.dev), ino:String(s.ino), size:s.size, mtimeMs:s.mtimeMs, ctimeMs:s.ctimeMs});
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const rejection = error => typeof error?.code === 'string' && /SOURCE_|VIDEO_|PROJECT_|READONLY|OPERATION_|TARGET_|FOLDER_|DATABASE_/.test(error.code);

async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sg-video-identity-recheck-')));
  const lib = await new Library(path.join(dir, 'data'), {directoryClassification:true}).init();
  let entry, catalog;
  t.after(async () => {
    const beforeClose = entry && {children:entry.media.children.size,handles:entry.media.handles.size,operations:catalog?.fileOperations.active.size||0};
    try {
      if (entry) {
        await entry.close();
        assert.deepEqual(beforeClose,{children:0,handles:0,operations:0},'All probes and file operations must settle before normal close');
        assert.equal(entry.media.exits.size,0);assert.equal(entry.media.closes.size,0);assert.equal(entry.media.work.size,0);
      }
    } finally { lib.db.close(); t.diagnostic('Owned SQLite and media resources closed; synthetic scene retained at '+dir); }
  });
  assert.ok(lib.db.prepare('SELECT sqlite_version() AS version').get().version);
  lib.enqueue = () => {};
  const projects = new Projects(lib).init(), assets = new ProjectAssets(lib).init();
  const storyboards = new StoryboardDatabase(lib, assets).init();
  entry = createStoryboardVideo({lib, storyboards, command:'/opt/homebrew/bin/ffprobe'});
  catalog = new ProjectVideos(entry.store, {directory:path.join(dir, 'owned-projects', 'video')});
  const project = projects.save(null, {name:'身份复核合成项目'}), other = projects.save(null, {name:'其他合成项目'});
  const file = path.join(dir, 'owned-fixture.mp4');
  const made = spawnSync('/opt/homebrew/bin/ffmpeg', ['-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=64x64:r=8:d=4','-c:v','libx264','-pix_fmt','yuv420p','-threads','1',file]);
  assert.equal(made.status, 0, made.stderr?.toString());
  assert.equal(made.signal, null);
  const bytes = await fs.readFile(file);
  assert.equal(typeof catalog.verifiedSource, 'function', 'Parent product must expose async catalog.verifiedSource(projectId, sourceId)');
  return {dir,lib,projects,assets,storyboards,entry,catalog,project,other,file,bytes};
}

async function imported(f, name = 'owned-'+randomUUID()+'.mp4', folderId = 'root') {
  const requestId = randomUUID();
  await f.catalog.start(f.project.id, {requestId,fileName:name,folderId,bytes:f.bytes.length,title:'保留的合成标题',notes:'原资料不可被身份复核覆盖',prompt:{mode:'new',title:'本方参考',text:'保留原提示词与采用关系'}});
  const result = await f.catalog.upload(f.project.id, requestId, Readable.from([f.bytes]));
  assert.equal(result.status, 'ready', result.error);
  return f.entry.store.source(f.project.id, result.videoId);
}
async function folder(f, name) {
  return f.catalog.folders.create(f.project.id, {requestId:randomUUID(),parentId:'root',name});
}
function initialize(f) {
  const p=syntheticSource(), shot=p.scenes[0].shots[0];
  p.scenes[0].shots=Array.from({length:3},()=>({...structuredClone(shot),id:'s-'+randomUUID(),duration_ms:1000,dialogue:[]}));
  return f.storyboards.initialize(f.project.id,{source:p,request_id:randomUUID(),expected_revision:null});
}
async function bind(f, source) {
  const s=await f.entry.store.state(f.project.id), inspection=await f.entry.store.inspect(f.project.id,[{sourceId:source.id}]);
  await f.entry.store.import(f.project.id,{requestId:randomUUID(),guards:{documentId:s.documentId,initializedAt:s.initializedAt,expectedStoryboardRevision:s.storyboardRevision,expectedPlanRevision:s.plan.revision,timingHash:s.timingHash},shotIds:[s.shots[0].id],videos:[{token:inspection.items[0].token,inMs:200,outMs:3800}]});
}
function snapshot(f, sourceId) {
  const db=f.lib.db, record=db.prepare('SELECT * FROM project_video_records WHERE id=?').get(sourceId);
  const data=record&&JSON.parse(record.data_json), asset=data?.mediaAssetId&&db.prepare('SELECT * FROM assets WHERE id=?').get(data.mediaAssetId);
  return {
    source:db.prepare('SELECT * FROM storyboard_video_sources WHERE id=?').get(sourceId),
    approvals:db.prepare('SELECT * FROM storyboard_video_approvals WHERE id IN (?,?) ORDER BY id').all(sourceId,f.catalog.managedKey(sourceId)),
    record, asset,
    root:asset&&db.prepare('SELECT * FROM roots WHERE id=?').get(asset.root_id),
    folders:db.prepare('SELECT * FROM project_video_folders WHERE project_id=? ORDER BY id').all(f.project.id),
    plans:db.prepare('SELECT * FROM storyboard_video_plans WHERE id=?').all(f.project.id),
    takes:db.prepare('SELECT * FROM storyboard_video_takes WHERE project_id=? ORDER BY id').all(f.project.id),
  };
}
async function ctimeOnly(source) {
  const before=await fs.stat(source.path);
  await pause(12);
  await fs.chmod(source.path, (before.mode & 0o777) ^ 0o100);
  const after=await fs.stat(source.path);
  assert.deepEqual([after.dev,after.ino,after.size,after.mtimeMs],[before.dev,before.ino,before.size,before.mtimeMs]);
  assert.notEqual(after.ctimeMs, before.ctimeMs);
  return stamp(after);
}
async function mtimeDrift(source) {
  const before=await fs.stat(source.path);
  await fs.utimes(source.path, before.atime, new Date(before.mtimeMs+5000));
  const after=await fs.stat(source.path);
  assert.deepEqual([after.dev,after.ino,after.size],[before.dev,before.ino,before.size]);
  assert.notEqual(after.mtimeMs, before.mtimeMs);
  return stamp(after);
}
async function opened(f, open) {
  const result=await open();
  try { assert.equal((await result.handle.stat()).isFile(),true); }
  finally { await f.entry.media.release(result.handle); }
}
function preserved(f, id, before) {
  const after=snapshot(f,id), source=f.entry.store.source(f.project.id,id);
  assert.equal(source.id,id);
  assert.deepEqual(after.record,before.record, 'Identity recheck cannot revise title/notes/prompt/managed metadata');
  assert.deepEqual(after.plans,before.plans);
  assert.deepEqual(after.takes,before.takes, 'Adopted take IDs/segments and nonzero offsets stay unchanged');
  assert.equal(after.asset.id,before.asset.id);
  assert.equal(after.asset.sha256,before.asset.sha256);
  assert.equal(f.entry.store.authorized(source),true);
  assert.equal(f.catalog.isManaged(f.project.id,source),true);
  assert.equal(after.approvals.length,2);
}
async function deniedWithoutWrites(f, source, call=()=>f.catalog.verifiedSource(f.project.id,source.id)) {
  const before=snapshot(f,source.id);
  await assert.rejects(call,rejection);
  assert.deepEqual(snapshot(f,source.id),before,'Rejected recheck must not partly refresh source, approvals, asset or adoption');
}
async function raceAfterStableHash(f, source, mutate) {
  const original=f.catalog.hash;
  let injected=false, expected;
  f.catalog.hash=async function(...args) {
    const result=await original.apply(this,args);
    if(!injected&&args[0]===source.path) { injected=true;await mutate();expected=snapshot(f,source.id); }
    return result;
  };
  try {
    await assert.rejects(()=>f.catalog.verifiedSource(f.project.id,source.id),rejection,'Expected guarded rejection at '+source.name);
    assert.equal(injected,true,'Race must occur inside the actual stable-hash boundary');
    assert.deepEqual(snapshot(f,source.id),expected,'Concurrent state must remain authoritative, with no partial identity writes');
  } finally { f.catalog.hash=original; }
}

// 1. All live callers must recheck, while the generic media gate remains strict.
test('ctime-only: real state/media/storyboard opens and move preview recover approved identity without changing adoption',async t=>{
  const f=await fixture(t);initialize(f);const source=await imported(f,'adopted.mp4');await bind(f,source);const before=snapshot(f,source.id);
  await ctimeOnly(source);
  await assert.rejects(()=>f.entry.media.open(source),e=>e.code==='SOURCE_CHANGED');
  const state=await f.entry.store.state(f.project.id);
  assert.equal(state.sources.find(s=>s.id===source.id).status,'available');preserved(f,source.id,before);
  assert.notDeepEqual(f.entry.store.source(f.project.id,source.id).identity,source.identity,'Keep the original pre-repair source snapshot stale');
  assert.deepEqual(await f.entry.store.status(source),{status:'available',errorCode:null},'A second request holding the original source snapshot must use the repaired current source');
  let current=f.entry.store.source(f.project.id,source.id);await ctimeOnly(current);
  await opened(f,()=>f.catalog.open(f.project.id,source.id));preserved(f,source.id,before);
  current=f.entry.store.source(f.project.id,source.id);await ctimeOnly(current);
  await opened(f,()=>f.entry.store.open(f.project.id,source.id));preserved(f,source.id,before);
  const target=await folder(f,'实际移动目标');current=f.entry.store.source(f.project.id,source.id);await ctimeOnly(current);
  const plan=await f.catalog.fileOperations.preview(f.project.id,{requestId:randomUUID(),kind:'move-video',sourceId:source.id,destinationFolderId:target.id});
  assert.equal(plan.ready,true);assert.deepEqual(plan.affectedShots,[]);preserved(f,source.id,before);
  await f.catalog.fileOperations.execute(f.project.id,{requestId:plan.requestId,previewHash:plan.previewHash,confirmUnbind:true});
  for(let n=0;f.catalog.fileOperations.active.has(plan.requestId)&&n<600;n++)await pause(5);
  assert.equal(f.catalog.fileOperations.active.has(plan.requestId),false);
  const receipt=f.catalog.fileOperations.row(f.project.id,plan.requestId);assert.equal(receipt.status,'ready',receipt.error);
  current=f.entry.store.source(f.project.id,source.id);assert.equal(path.dirname(current.path),target.path);
  assert.equal(sha(await fs.readFile(current.path)),sha(f.bytes));preserved(f,source.id,before);
});

// 2. utimes unavoidably also changes ctime; only mtime is explicitly edited and bytes remain unchanged.
test('mtime-only edit with identical bytes refreshes both approvals and asset time, not metadata revision',async t=>{
  const f=await fixture(t),source=await imported(f),before=snapshot(f,source.id),identity=await mtimeDrift(source);
  await assert.rejects(()=>f.entry.media.open(source),e=>e.code==='SOURCE_CHANGED');
  const verified=await f.catalog.verifiedSource(f.project.id,source.id);
  assert.deepEqual(verified.identity,identity);assert.equal(sha(await fs.readFile(verified.path)),before.asset.sha256);
  assert.equal(snapshot(f,source.id).asset.mtime,identity.mtimeMs);preserved(f,source.id,before);
  const approvals=snapshot(f,source.id).approvals;for(const row of approvals)assert.notEqual(row.proof_hash,before.approvals.find(old=>old.id===row.id).proof_hash);
});

// 3. Content equality never substitutes for permanent physical identity.
test('same inode changed bytes and replacement inode identical bytes both reject without refreshed approval',async t=>{
  const f=await fixture(t),changed=await imported(f,'changed.mp4'),old=await fs.stat(changed.path),bytes=Buffer.from(f.bytes);bytes[bytes.length-1]^=1;
  await fs.writeFile(changed.path,bytes);assert.equal((await fs.stat(changed.path)).ino,old.ino);assert.equal(bytes.length,f.bytes.length);await deniedWithoutWrites(f,changed);
  const replaced=await imported(f,'replacement.mp4'),prior=await fs.stat(replaced.path),replacement=path.join(f.dir,'replacement-owned.mp4');
  await fs.writeFile(replacement,f.bytes);await fs.rename(replaced.path,path.join(f.dir,'retained-original.mp4'));await fs.rename(replacement,replaced.path);
  assert.notEqual((await fs.stat(replaced.path)).ino,prior.ino);assert.equal(sha(await fs.readFile(replaced.path)),sha(f.bytes));await deniedWithoutWrites(f,replaced);
});

// 4. Missing one approval, trusted digest, management, or project ownership never grants recovery.
test('no approval, no managed approval/digest, legacy, removed and cross-project sources cannot auto-reauthorize',async t=>{
  const f=await fixture(t);
  for(const kind of ['approval','managed-approval','digest','removed']) {
    const source=await imported(f,kind+'.mp4');await ctimeOnly(source);
    if(kind==='approval'||kind==='managed-approval')f.lib.db.prepare('DELETE FROM storyboard_video_approvals WHERE id=?').run(kind==='approval'?source.id:f.catalog.managedKey(source.id));
    else {const {data,row}=f.catalog.metadata(f.project.id,source);f.catalog.record(f.project.id,source.id,{...data,...(kind==='digest'?{sha256:null}:{removedAt:Date.now()})},row.revision+1);}
    await deniedWithoutWrites(f,source);
  }
  const probe=await f.entry.media.probe(f.file),legacy={id:randomUUID(),project_id:f.project.id,...probe},now=Date.now();
  f.lib.db.prepare('INSERT INTO storyboard_video_sources VALUES(?,?,?,?,?)').run(legacy.id,f.project.id,canonical(probe),now,now);f.entry.store.approve(legacy);await ctimeOnly(legacy);await deniedWithoutWrites(f,legacy);
  const source=await imported(f,'other-project.mp4');await ctimeOnly(source);await deniedWithoutWrites(f,source,()=>f.catalog.verifiedSource(f.other.id,source.id));
});

// 5. These are synthetic gate records, never adopted unknown operations or recovery attempts.
test('migration/read-only and unresolved original operations prevent identity writes',async t=>{
  const f=await fixture(t);initialize(f);const target=await folder(f,'未知操作目标'),source=await imported(f);await ctimeOnly(source);
  f.lib.migrating=true;try{await deniedWithoutWrites(f,source);}finally{f.lib.migrating=false;}
  const previous=process.env.MEDIA_READONLY_FILES;process.env.MEDIA_READONLY_FILES='1';try{await deniedWithoutWrites(f,source);}finally{if(previous===undefined)delete process.env.MEDIA_READONLY_FILES;else process.env.MEDIA_READONLY_FILES=previous;}
  const requestId=randomUUID(),now=Date.now();f.lib.db.prepare('INSERT INTO project_video_operations VALUES(?,?,?,?,?)').run(requestId,f.project.id,canonical({requestId,status:'unknown',source:source.path,moves:[]}),now,now);
  await deniedWithoutWrites(f,source);const beforeStatus=snapshot(f,source.id);
  assert.deepEqual(await f.entry.store.status(source),{status:'changed',errorCode:'OPERATION_UNSETTLED'});
  const list=await f.catalog.list(f.project.id,{folderId:'root'});assert.equal(list.videos[0].status,'changed');assert.equal(list.videos[0].errorCode,'OPERATION_UNSETTLED');
  assert.deepEqual(snapshot(f,source.id),beforeStatus,'Read-only status listing cannot refresh UNKNOWN source/proof');
  await assert.rejects(()=>f.catalog.open(f.project.id,source.id),e=>e.code==='OPERATION_UNSETTLED');
  await assert.rejects(()=>f.entry.store.open(f.project.id,source.id),e=>e.code==='OPERATION_UNSETTLED');
  await assert.rejects(()=>f.catalog.fileOperations.preview(f.project.id,{requestId:randomUUID(),kind:'move-video',sourceId:source.id,destinationFolderId:target.id}),e=>e.code==='OPERATION_UNSETTLED');
  assert.deepEqual(snapshot(f,source.id),beforeStatus);
  assert.equal(JSON.parse(f.lib.db.prepare('SELECT data_json FROM project_video_operations WHERE id=?').get(requestId).data_json).status,'unknown');
});

// 6. Changes after a real stable read but before verifiedSource resumes are still during verification.
test('hash-boundary file change and either approval revoked mid-verification reject without partial updates',async t=>{
  const f=await fixture(t);
  for(const kind of ['file','approval','managed-approval']) {
    const source=await imported(f,kind+'-race.mp4');await ctimeOnly(source);
    await raceAfterStableHash(f,source,async()=>{
      if(kind==='file'){const bytes=Buffer.from(f.bytes);bytes[bytes.length-1]^=2;await fs.writeFile(source.path,bytes);}
      else f.lib.db.prepare('DELETE FROM storyboard_video_approvals WHERE id=?').run(kind==='approval'?source.id:f.catalog.managedKey(source.id));
    });
  }
  // The no-drift fast path also awaits I/O, so it must not return a stale authorization or metadata snapshot.
  for(const kind of ['approval','managed-approval','record']) {
    const source=await imported(f,'fast-'+kind+'.mp4'),verify=f.entry.media.verify;let injected=false,expected;
    f.entry.media.verify=async function(candidate) { await verify.call(this,candidate);if(!injected&&candidate.path===source.path) { injected=true;
      if(kind==='record'){const {data,row}=f.catalog.metadata(f.project.id,source);f.catalog.record(f.project.id,source.id,{...data,notes:'快路径并发资料'},row.revision+1);}
      else f.lib.db.prepare('DELETE FROM storyboard_video_approvals WHERE id=?').run(kind==='approval'?source.id:f.catalog.managedKey(source.id));
      expected=snapshot(f,source.id);
    }};
    try{await assert.rejects(()=>f.catalog.verifiedSource(f.project.id,source.id),rejection,'Fast-path await must recheck '+kind);assert.equal(injected,true);assert.deepEqual(snapshot(f,source.id),expected);}
    finally{f.entry.media.verify=verify;}
  }

});

// 7. CAS must compare the original source, record, asset/root and folder registration snapshots.
test('concurrent source/record/root/folder registration edits win over identity refresh, with no partial writes',async t=>{
  const f=await fixture(t),target=await folder(f,'CAS合成目录');
  const failures=[];
  for(const kind of ['source','record','root','folder','asset']) {
    const source=await imported(f,kind+'-cas.mp4',target.id);await ctimeOnly(source);
    try { await raceAfterStableHash(f,source,async()=>{
      const {data,row}=f.catalog.metadata(f.project.id,source);
      if(kind==='source'){const changed={...JSON.parse(snapshot(f,source.id).source.data_json),name:'并发来源名称.mp4'};f.lib.db.prepare('UPDATE storyboard_video_sources SET data_json=? WHERE id=?').run(canonical(changed),source.id);}
      if(kind==='record')f.catalog.record(f.project.id,source.id,{...data,notes:'并发资料必须保留'},row.revision+1);
      if(kind==='root')f.lib.db.prepare('UPDATE roots SET revision=revision+1 WHERE id=?').run(snapshot(f,source.id).asset.root_id);
      if(kind==='folder'){const old=f.catalog.folders.row(f.project.id,target.id);f.catalog.folders.write(f.project.id,target.id,f.catalog.folders.data(old));}
      if(kind==='asset')f.lib.db.prepare('UPDATE assets SET sha256=? WHERE id=?').run('f'.repeat(64),data.mediaAssetId);
    }); } catch(error) { failures.push({kind,message:error.message}); }
  }
  assert.deepEqual(failures,[],JSON.stringify(failures));
});

// 8. A real SQLite abort after the first writes proves transactional rollback, not just early guards.
test('SQLite failure on second approval rolls back source identity, first approval and asset time atomically',async t=>{
  const f=await fixture(t),source=await imported(f);await mtimeDrift(source);const before=snapshot(f,source.id),key=f.catalog.managedKey(source.id);
  f.lib.db.exec(`CREATE TEMP TRIGGER owned_identity_recheck_abort BEFORE UPDATE OF proof_hash ON storyboard_video_approvals WHEN NEW.id='${key}' BEGIN SELECT RAISE(ABORT,'owned identity approval failure'); END;`);
  try{await assert.rejects(()=>f.catalog.verifiedSource(f.project.id,source.id),/owned identity approval failure/);assert.deepEqual(snapshot(f,source.id),before);}
  finally{f.lib.db.exec('DROP TRIGGER owned_identity_recheck_abort');}
});

// Device numbering may change between boots. Only explicit upgrade may accept
// that drift, using the pre-existing digest and original approvals, never the
// current bytes as a new baseline. The actual fixture files are not replaced.
function previousDevice(f, source, scannerRefreshed=false) {
  const probe=JSON.parse(snapshot(f,source.id).source.data_json);
  probe.identity.dev=String(Number(probe.identity.dev)+2);
  f.lib.db.prepare('UPDATE storyboard_video_sources SET data_json=? WHERE id=?').run(canonical(probe),source.id);
  const old=f.entry.store.source(f.project.id,source.id);
  if(!scannerRefreshed)f.lib.db.prepare('UPDATE assets SET dev=? WHERE id=?').run(old.identity.dev,f.catalog.metadata(f.project.id,old).data.mediaAssetId);
  f.entry.store.approve(old);f.catalog.approveManaged(old);
  return old;
}
async function finishedUpgrade(f) {
  const plan=await f.catalog.upgradePlan(f.project.id),requestId=randomUUID();
  await f.catalog.upgrade(f.project.id,{requestId,previewHash:plan.previewHash});
  const deadline=Date.now()+5000;
  while(f.catalog.receipt(f.project.id,requestId).status==='running'&&Date.now()<deadline)await pause(5);
  const receipt=f.catalog.receipt(f.project.id,requestId);
  assert.notEqual(receipt.status,'running','Owned upgrade must settle within the test bound');
  return receipt;
}
test('explicit upgrade: device drift with trusted identical bytes preserves IDs, metadata and adopted offsets',async t=>{
  const f=await fixture(t);initialize(f);
  const first=await imported(f,'old-device.mp4');await bind(f,first);
  const second=await imported(f,'scanner-current-device.mp4');
  const sources=[previousDevice(f,first,true),previousDevice(f,second,true)],before=sources.map(s=>snapshot(f,s.id));
  for(const source of sources){
    await assert.rejects(()=>f.entry.media.open(source),e=>e.code==='SOURCE_CHANGED');
    await deniedWithoutWrites(f,source);
  }
  const receipt=await finishedUpgrade(f);assert.equal(receipt.status,'ready',receipt.error);
  assert.equal(receipt.results.length,2);assert.ok(receipt.results.every(r=>r.status==='ready'));
  for(const [i,old]of sources.entries()){
    const current=f.entry.store.source(f.project.id,old.id),after=snapshot(f,old.id),was=before[i];
    assert.equal(current.path,old.path);assert.deepEqual(current.identity,stamp(await fs.stat(old.path)));
    assert.deepEqual(JSON.parse(after.record.data_json),JSON.parse(was.record.data_json));
    assert.equal(after.asset.id,was.asset.id);assert.equal(after.asset.sha256,was.asset.sha256);
    assert.deepEqual(after.plans,was.plans);assert.deepEqual(after.takes,was.takes);
    assert.equal(f.catalog.isManaged(f.project.id,current),true);
    assert.equal(sha(await fs.readFile(current.path)),sha(f.bytes));
    await opened(f,()=>f.catalog.open(f.project.id,current.id));
  }
  assert.equal(f.entry.store.sources(f.project.id).length,2);
  assert.equal((await fs.readdir(path.dirname(first.path))).length,2,'No extra permanent video copy');
  assert.equal((await f.catalog.upgradePlan(f.project.id)).completed,true);
});
test('explicit upgrade: changed bytes, replaced inode and missing prior authority stay rejected',async t=>{
  const f=await fixture(t);initialize(f);
  for(const kind of ['bytes','inode','approval','managed-approval','digest','asset-digest','removed']){
    const source=await imported(f,kind+'-device.mp4');await bind(f,source);const old=previousDevice(f,source);
    if(kind==='bytes'){const changed=Buffer.from(f.bytes);changed[changed.length-1]^=1;await fs.writeFile(old.path,changed);}
    if(kind==='inode'){const replacement=path.join(f.dir,'new-inode.mp4');await fs.writeFile(replacement,f.bytes);await fs.rename(old.path,path.join(f.dir,'retained-'+kind+'.mp4'));await fs.rename(replacement,old.path);}
    if(kind==='approval'||kind==='managed-approval')f.lib.db.prepare('DELETE FROM storyboard_video_approvals WHERE id=?').run(kind==='approval'?old.id:f.catalog.managedKey(old.id));
    if(kind==='digest'||kind==='removed'){const {data,row}=f.catalog.metadata(f.project.id,old);f.catalog.record(f.project.id,old.id,{...data,...(kind==='digest'?{sha256:null}:{removedAt:Date.now()})},row.revision+1);}
    if(kind==='asset-digest')f.lib.db.prepare('UPDATE assets SET sha256=? WHERE id=?').run('f'.repeat(64),f.catalog.metadata(f.project.id,old).data.mediaAssetId);
    await deniedWithoutWrites(f,old,()=>f.catalog.upgradeSource(f.project.id,old,f.catalog.row(f.project.id,old.id).revision));
  }
});
test('explicit upgrade: authorization revoked during copy cannot be reissued by registration',async t=>{
  const f=await fixture(t);initialize(f);const source=await imported(f);await bind(f,source);const old=previousDevice(f,source);
  const probe=f.entry.media.probe;let expected,injected=false;
  f.entry.media.probe=async function(file){const result=await probe.call(this,file);if(file.endsWith('original.partial')){injected=true;f.lib.db.prepare('DELETE FROM storyboard_video_approvals WHERE id=?').run(f.catalog.managedKey(old.id));expected=snapshot(f,old.id);}return result;};
  try{
    await assert.rejects(()=>f.catalog.upgradeSource(f.project.id,old,f.catalog.row(f.project.id,old.id).revision),rejection);
    assert.equal(injected,true);assert.deepEqual(snapshot(f,old.id),expected);
  }finally{f.entry.media.probe=probe;}
});
