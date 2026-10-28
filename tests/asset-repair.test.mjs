import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {Library} from '../server/library.mjs';import {AssetFingerprints} from '../server/asset-fingerprints.mjs';import {AssetRepair,repairRootState} from '../server/asset-repair.mjs';import {CloudAudioUpload} from '../server/cloud-audio-upload.mjs';import {CloudUploadBatchStore} from '../server/cloud-upload-batch-store.mjs';import {reconcileRoot,reconcilePaths,createManifestSync} from '../server/reconcile.mjs';import {readManifest,writeManifest} from '../server/fs-manifest.mjs';import {mysqlColumnType} from '../server/mysql.mjs';
const options={tagFiles:false,hashBudgetFiles:0,hashBudgetBytes:0,matchHashBudgetFiles:0};const registrations=[];const owner='synthetic-local-cookie';
export async function fixture(t){
 const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-repair-')));registrations.push({directory:base,policy:'RETAIN_ALL',setup:true});console.log(JSON.stringify(registrations.at(-1)));
 const lib=await new Library(path.join(base,'data'),{directoryClassification:true}).init();lib.enqueue=()=>{};
 const roots=[];for(const name of ['source','target']){const dir=path.join(base,name);await fs.mkdir(path.join(dir,'类别','子类'),{recursive:true});roots.push(await lib.addRoot(dir,'music'));}
 const original=path.join(roots[0].path,'类别','子类','old.wav'),target=path.join(roots[1].path,'类别','子类','new.wav');await fs.writeFile(original,'fixture actual identical bytes');await reconcileRoot(lib,roots[0],options);
 const asset=lib.db.prepare('SELECT id FROM assets').get();lib.patch(asset.id,{note:'keep original note',favorite:false,confirmed:true,tags:['标签甲','标签乙'],capturedAt:'2025-01-02T03:04:05'});
 const hashes=new AssetFingerprints(lib);assert.equal((await hashes.wait(hashes.start({mode:'fingerprint',assetIds:[asset.id]}).id)).saved,1);
 await fs.copyFile(original,target);await fs.rename(original,path.join(base,'retained-source.wav'));
 let upload=await new CloudAudioUpload(lib,{enabled:true}).init(),store=new CloudUploadBatchStore(lib.db).init(),repair=new AssetRepair(lib,{upload,batchStore:store});
 const f={base,lib,roots,original,target,assetId:asset.id,hashes,get upload(){return upload;},get store(){return store;},get repair(){return repair;},raw(){return lib.db.prepare('SELECT * FROM assets WHERE id=?').get(asset.id);},input(){return {assetId:asset.id,targetRootId:roots[1].id,targetRelativePath:'类别/子类/new.wav'};},preview(){return repair.preview(f.input(),owner);},confirm(p){return repair.confirm({previewId:p.previewId,commandId:crypto.randomUUID()},owner);},setRepair(opts={}){repair=new AssetRepair(lib,{upload,batchStore:store,...opts});return repair;},async reopen(){await hashes.dispose();await upload.dispose();lib.db.close();const Database=(await import('better-sqlite3')).default;lib.db=new Database(path.join(base,'data','library.sqlite'));store=new CloudUploadBatchStore(lib.db);upload=await new CloudAudioUpload(lib,{enabled:true}).init();repair=new AssetRepair(lib,{upload,batchStore:store});}};
 t.after(async()=>{await hashes.dispose();await upload.dispose();lib.db.close();});return f;
}
test.after(()=>console.log(JSON.stringify({registrations,after:'known promises/DB handles closed, all roots retained, no FS inventory or recursive removal'})));

test('real different-name/inode restore retains original ID/metadata/references and media bytes; journal/markers complete and repeated confirm idempotent',async t=>{
 const f=await fixture(t),before=f.raw(),fileBefore=await fs.stat(f.target),bytes=await fs.readFile(f.target);const p=await f.preview();assert.equal(f.raw().path,before.path);assert.equal(f.lib.db.prepare('SELECT COUNT(*) n FROM asset_repair_journal').get().n,0);
 const input={previewId:p.previewId,commandId:crypto.randomUUID()},result=await f.repair.confirm(input,owner);assert.equal(result.phase,'COMPLETE',JSON.stringify(result));const after=f.raw();assert.equal(after.id,before.id);assert.equal(after.path,f.target);assert.equal(after.root_id,f.roots[1].id);assert.notEqual(after.ino,before.ino);for(const field of ['note','favorite','confirmed','tags','captured_ms','capture_source'])assert.equal(after[field],before[field],field);assert.equal(after.category,'类别');assert.equal(after.sub,'子类');assert.equal(after.sha256,null);assert.deepEqual(await fs.readFile(f.target),bytes);assert.equal((await fs.stat(f.target)).mtimeMs,fileBefore.mtimeMs);
 assert.equal((await readManifest(f.roots[0])).manifest.entries[after.id],undefined);const m=(await readManifest(f.roots[1])).manifest;assert.equal(m.entries[after.id].relPath,'类别/子类/new.wav');assert.equal(m.entries[after.id].fingerprintBinding,undefined);assert.equal(m.repairOperations[result.operationId].phase,'COMPLETE');assert.deepEqual(await f.repair.confirm(input,owner),result);
 await assert.rejects(()=>f.repair.confirm({...input,previewId:crypto.randomUUID()},owner),{code:'IDEMPOTENCY_CONFLICT'});
});
for(const variant of ['source-restored','root-retired','root-version','target-indexed','pending','metadata','reference','upload-missing','upload-unknown','active-upload'])test(`confirm rejects ${variant} before asset writes`,async t=>{
 const f=await fixture(t),before=f.raw(),p=await f.preview();
 if(variant==='source-restored')await fs.copyFile(f.target,f.original);
 if(variant==='root-retired')f.lib.db.prepare('UPDATE roots SET retired=1 WHERE id=?').run(f.roots[1].id);
 if(variant==='root-version')f.lib.db.prepare('UPDATE roots SET revision=revision+1 WHERE id=?').run(f.roots[0].id);
 if(variant==='target-indexed')f.lib.db.prepare('INSERT INTO assets(id,root_id,path) VALUES(?,?,?)').run(crypto.randomUUID(),f.roots[1].id,f.target);
 if(variant==='pending')f.lib.db.prepare("INSERT INTO operations(id,asset_id,status) VALUES(?,?,'pending')").run(crypto.randomUUID(),f.assetId);
 if(variant==='metadata')f.lib.patch(f.assetId,{note:'new value'});
 if(variant==='reference')f.lib.db.prepare("INSERT INTO operations(id,asset_id,status) VALUES(?,?,'done')").run(crypto.randomUUID(),f.assetId);
 if(variant==='upload-missing'){const cached=f.repair.previews.get(p.previewId);f.setRepair({batchStore:null}).previews.set(p.previewId,cached);}
 if(variant==='upload-unknown')await fs.writeFile(path.join(f.lib.dataDir,'cloud-upload-intents','intents.json'),'not JSON');
 if(variant==='active-upload')f.upload.controllers.set('known-active',new AbortController());
 if(variant==='upload-missing'){await assert.rejects(()=>f.confirm(p),{code:'UPLOAD_STATE_UNKNOWN'});}
 else await assert.rejects(()=>f.confirm(p));
 assert.equal(f.raw().path,before.path);assert.equal(f.lib.db.prepare('SELECT COUNT(*) n FROM asset_repair_journal').get().n,0);
 if(variant==='active-upload')f.upload.controllers.clear();
});
test('session/expiry/no trusted historical hash and occupied target cannot create confirmation',async t=>{
 const f=await fixture(t),p=await f.preview();await assert.rejects(()=>f.repair.confirm({previewId:p.previewId,commandId:crypto.randomUUID()},'another-local-cookie'),{code:'PREVIEW_EXPIRED'});f.repair.previews.get(p.previewId).expiresAt=0;await assert.rejects(()=>f.confirm(p),{code:'PREVIEW_EXPIRED'});f.lib.db.prepare('UPDATE assets SET sha256=NULL WHERE id=?').run(f.assetId);await assert.rejects(()=>f.preview(),{code:'NO_TRUSTED_FINGERPRINT'});
});
for(const point of ['before-backup','before-marker-write','before-transaction','after-transaction'])test(`failure/reopen phase at ${point}`,async t=>{
 const f=await fixture(t),before=f.raw();let failed=false;f.setRepair({hook:async stage=>{if(stage===point&&!failed){failed=true;throw Object.assign(Error('controlled'),{code:'CONTROLLED_FAILURE'});}}});const p=await f.preview();let result;
 if(point==='before-backup'){await assert.rejects(()=>f.confirm(p));assert.equal(f.lib.db.prepare('SELECT COUNT(*) n FROM asset_repair_journal').get().n,0);assert.equal(f.raw().path,before.path);return;}
 result=await f.confirm(p);assert.equal(failed,true);assert.equal(result.complete,false);assert.equal(f.raw().path,point==='after-transaction'?f.target:before.path);assert.equal(result.phase,point==='after-transaction'?'MIRROR_PENDING':'PREPARED');const row=f.repair.row(result.operationId);assert.equal(row.data.source.a.note,before.note);
 await f.reopen();assert.equal(repairRootState(f.lib,f.roots[0]).blocked,true);const recovered=await f.repair.recover(result.operationId,{expectedVersion:result.version},'new-local-session-after-restart');assert.equal(recovered.phase,point==='after-transaction'?'COMPLETE':'ABORTED',JSON.stringify(recovered));assert.equal(f.raw().path,point==='after-transaction'?f.target:before.path);assert.equal(f.raw().note,before.note);
});
test('transaction failure rolls asset and journal state back; explicit recover aborts prepared state',async t=>{
 const f=await fixture(t),p=await f.preview();f.lib.db.exec("CREATE TRIGGER reject_restore BEFORE UPDATE OF path ON assets BEGIN SELECT RAISE(ABORT,'fixture tx failure'); END");const result=await f.confirm(p);assert.equal(result.phase,'PREPARED');assert.equal(f.raw().path,f.original);f.lib.db.exec('DROP TRIGGER reject_restore');assert.equal((await f.repair.recover(result.operationId,{expectedVersion:result.version},owner)).phase,'ABORTED');
});
test('last asynchronous boundary target claim/root/metadata change is rejected and prepared audit retained',async t=>{
 for(const variant of ['target','root','metadata']){const f=await fixture(t);f.setRepair({hook:async stage=>{if(stage==='before-transaction'){if(variant==='target')f.lib.db.prepare('INSERT INTO assets(id,root_id,path) VALUES(?,?,?)').run(crypto.randomUUID(),f.roots[1].id,f.target);else if(variant==='root')f.lib.db.prepare('UPDATE roots SET retired=1 WHERE id=?').run(f.roots[0].id);else f.lib.patch(f.assetId,{note:'latest manual'});}}});const p=await f.preview(),result=await f.confirm(p);assert.equal(result.phase,'PREPARED');assert.equal(f.raw().path,f.original);}
});
test('old manifest and metadataSync/reconcile cannot resurrect prior path; DB loss with marker defers instead of inferring commit',async t=>{
 const f=await fixture(t),old=(await readManifest(f.roots[0])).manifest,p=await f.preview(),result=await f.confirm(p);assert.equal(result.complete,true);await writeManifest(f.roots[0],old);await reconcileRoot(f.lib,f.roots[0],options);assert.equal(f.raw().path,f.target);const sync=createManifestSync(f.lib);sync.touch(f.roots[0].id);sync.stop();await sync.flush();assert.equal((await readManifest(f.roots[0])).manifest.entries[f.assetId],undefined);sync.stop();await reconcileRoot(f.lib,f.roots[1],options);assert.equal(f.raw().path,f.target);assert.equal(f.lib.db.prepare('SELECT COUNT(*) n FROM assets').get().n,1);
 f.lib.db.prepare('DELETE FROM asset_repair_journal').run();const state=await reconcileRoot(f.lib,f.roots[1],options);assert.equal(state.repairPending,true);assert.equal(f.lib.db.prepare('SELECT COUNT(*) n FROM assets').get().n,1);
});
test('repair source gate rejects new upload both before and after actual async source wait',async t=>{
 const f=await fixture(t);f.lib.locks.add(f.assetId);await assert.rejects(()=>f.upload.source({assetId:f.assetId}),{code:'SOURCE_CHANGED'});f.lib.locks.delete(f.assetId);const source=f.lib.source.bind(f.lib);f.lib.source=async()=>{f.lib.locks.add(f.assetId);return {a:f.raw(),p:f.target,stat:await fs.stat(f.target)};};await assert.rejects(()=>f.upload.source({assetId:f.assetId}),{code:'SOURCE_CHANGED'});f.lib.source=source;f.lib.locks.clear();
});
test('persistent intents are checked even with empty RAM; store column/JSON disagreement and bounded overflow are unknown',async t=>{
 const f=await fixture(t);await fs.writeFile(path.join(f.lib.dataDir,'cloud-upload-intents','intents.json'),JSON.stringify([{assetId:f.assetId}]));assert.equal((await f.upload.repairState([f.assetId])).known,false);await fs.writeFile(path.join(f.lib.dataDir,'cloud-upload-intents','intents.json'),'[]');assert.equal((await f.upload.repairState([f.assetId])).state,'idle');
 f.store.insert('cloud_upload_eligibility_cache',{cloudServiceKey:'a'.repeat(64),accountId:crypto.randomUUID(),sha256:'b'.repeat(64),verifiedSourceVersion:null,serverStateVersion:1,admissionEpoch:1,generation:null,checkedAt:1,projection:null});assert.equal(f.store.repairState([f.assetId]).known,true);f.lib.db.prepare('UPDATE cloud_upload_eligibility_cache SET version=99').run();assert.equal(f.store.repairState([f.assetId]).known,false);
});
test('new MySQL journal mapping keeps indexed IDs/hashes bounded and does not mistake operation_id for legacy id',()=>{
 for(const [name,type]of [['operation_id','VARCHAR(36) PRIMARY KEY'],['idempotency_key','CHAR(64)'],['canonical_asset_id','VARCHAR(36)'],['alias_asset_id','VARCHAR(36)'],['version','BIGINT'],['phase','VARCHAR(24)'],['payload','LONGTEXT']])assert.equal(mysqlColumnType('asset_repair_journal',{name}),type);
});

function gate(){let release,entered;const promise=new Promise(r=>release=r),ready=new Promise(r=>entered=r);return {promise,ready,release,entered};}
for(const kind of ['full','paths','metadata'])test(`actual ${kind} await owns activity until settled; repair releases locks and BUSY without journal`,async t=>{
 const f=await fixture(t),p=await f.preview(),block=gate(),originalRead=fs.readFile;let seen=false,sync;
 fs.readFile=async(...args)=>{if(String(args[0])===path.join(f.roots[0].path,'.shiguang','manifest.json')&&!seen){seen=true;block.entered();await block.promise;}return originalRead(...args);};
 let work;
 try{
  if(kind==='full')work=reconcileRoot(f.lib,f.roots[0],options);
  else if(kind==='paths')work=reconcilePaths(f.lib,f.roots[0],['类别/子类/old.wav'],options);
  else {sync=createManifestSync(f.lib);sync.touch(f.roots[0].id);sync.stop();work=sync.flush();}
  await block.ready;assert.equal(f.lib.repairIndexReaders,1);if(sync)sync.stop();assert.equal(f.lib.repairIndexReaders,1,'requesting stop must not fake settlement');
  await assert.rejects(()=>f.confirm(p),{code:'BUSY'});assert.equal(f.lib.locks.size,0);assert.equal(f.lib.db.prepare('SELECT COUNT(*) n FROM asset_repair_journal').get().n,0);assert.equal(f.raw().path,f.original);
 }finally{block.release();await work;fs.readFile=originalRead;sync?.stop();}
 assert.equal(f.lib.repairIndexReaders,0);
});
test('held repair defers all three index writers before FS work and retains metadata intent without scheduling',async t=>{
 const f=await fixture(t),before=f.raw(),originalRead=fs.readFile;let reads=0;const sync=createManifestSync(f.lib);f.repair.lock(f.assetId);
 fs.readFile=async(...args)=>{reads++;return originalRead(...args);};
 try{const full=await reconcileRoot(f.lib,f.roots[0],options),quick=await reconcilePaths(f.lib,f.roots[0],['类别/子类/old.wav'],options);sync.touch(f.roots[0].id);sync.stop();const metadata=await sync.flush();for(const result of [full,quick,metadata])assert.equal(result.deferred,true);assert.equal(full.code,'ASSET_OPERATION_IN_PROGRESS');assert.equal(quick.code,'ASSET_OPERATION_IN_PROGRESS');assert.equal(metadata.roots[0].code,'ASSET_OPERATION_IN_PROGRESS');assert.equal(reads,0);assert.deepEqual(f.raw(),before);assert.equal(f.lib.repairIndexReaders??0,0);}finally{fs.readFile=originalRead;f.repair.unlock(f.assetId);sync.stop();}
 await sync.flush();sync.stop();assert.equal(f.lib.repairIndexReaders,0);
});
test('nested index work and actual throw balance counters exactly',async t=>{
 const f=await fixture(t),originalRead=fs.readFile;let nested=false;
 fs.readFile=async(...args)=>{if(!nested&&String(args[0])===path.join(f.roots[0].path,'.shiguang','manifest.json')){nested=true;assert.equal(f.lib.repairIndexReaders,1);const inner=reconcilePaths(f.lib,f.roots[1],[],options);assert.equal(f.lib.repairIndexReaders,2);await inner;assert.equal(f.lib.repairIndexReaders,1);}return originalRead(...args);};
 try{await reconcileRoot(f.lib,f.roots[0],options);}finally{fs.readFile=originalRead;}
 assert.equal(nested,true);assert.equal(f.lib.repairIndexReaders,0);const root={...f.roots[0],get path(){throw Error('actual failure');}};await assert.rejects(()=>reconcileRoot(f.lib,root,options),/actual failure/);assert.equal(f.lib.repairIndexReaders,0);
});
test('persistent intent appearing at final boundary invalidates proof and cannot write restored projection',async t=>{
 const f=await fixture(t);f.setRepair({hook:async stage=>{if(stage==='before-transaction')await fs.writeFile(path.join(f.lib.dataDir,'cloud-upload-intents','intents.json'),'[]');}});const p=await f.preview(),result=await f.confirm(p);assert.equal(result.phase,'PREPARED');assert.equal(result.error,'UPLOAD_STATE_CHANGED');assert.equal(f.raw().path,f.original);
});

test('actual journal insert and manifest fsync faults leave original projection unchanged',async t=>{
 for(const variant of ['journal','fsync']){const f=await fixture(t),p=await f.preview(),before=f.raw();let syncFailed=false;const open=fs.open;
  if(variant==='journal')f.lib.db.exec("CREATE TRIGGER reject_journal BEFORE INSERT ON asset_repair_journal BEGIN SELECT RAISE(ABORT,'controlled backup failure'); END");
  else fs.open=async(...args)=>{const h=await open(...args);if(String(args[0]).includes('manifest.json.tmp-')){const sync=h.sync.bind(h);h.sync=async()=>{if(!syncFailed){syncFailed=true;throw Object.assign(Error('controlled fsync'),{code:'EIO'});}return sync();};}return h;};
  try{if(variant==='journal')await assert.rejects(()=>f.confirm(p));else assert.equal((await f.confirm(p)).phase,'PREPARED');}finally{fs.open=open;}
  assert.equal(f.raw().path,before.path);assert.equal(f.raw().note,before.note);if(variant==='journal')assert.equal(f.lib.db.prepare('SELECT COUNT(*) n FROM asset_repair_journal').get().n,0);else assert.equal(syncFailed,true);
 }
});
test('complete audit does not invalidate new fingerprints or block a later legitimate current path',async t=>{
 const f=await fixture(t),p=await f.preview();assert.equal((await f.confirm(p)).phase,'COMPLETE');const hashes=new AssetFingerprints(f.lib),job=hashes.start({mode:'fingerprint',assetIds:[f.assetId]});assert.equal((await hashes.wait(job.id)).saved,1);await hashes.dispose();const sha=f.raw().sha256;await reconcileRoot(f.lib,f.roots[1],options);assert.equal(f.raw().sha256,sha);assert.equal((await readManifest(f.roots[1])).manifest.entries[f.assetId].fingerprintBinding.state,'committed');
 const later=path.join(path.dirname(f.target),'later.wav');await fs.rename(f.target,later);f.lib.db.prepare('UPDATE assets SET path=?,name=?,sha256=NULL WHERE id=?').run(later,'later.wav',f.assetId);const result=await reconcileRoot(f.lib,f.roots[1],options);assert.notEqual(result.repairPending,true);assert.equal(f.raw().path,later);assert.equal((await readManifest(f.roots[1])).manifest.entries[f.assetId].relPath,'类别/子类/later.wav');
});
test('cached second preview cannot start another journal while first PREPARED operation is unresolved',async t=>{
 const f=await fixture(t),p1=await f.preview(),p2=await f.preview();f.repair.hook=async stage=>{if(stage==='before-marker-write')throw Object.assign(Error('controlled'),{code:'STOP_MARKER'});};const first=await f.confirm(p1);assert.equal(first.phase,'PREPARED');await assert.rejects(()=>f.confirm(p2),{code:'REPAIR_PENDING'});assert.equal(f.lib.db.prepare('SELECT COUNT(*) n FROM asset_repair_journal').get().n,1);
});
test('read-only mode, malformed relative paths, and bounded unknown associations fail closed',async t=>{
 const f=await fixture(t);await assert.rejects(()=>f.repair.preview({...f.input(),targetRelativePath:'../escape.wav'},owner),{code:'INVALID_TARGET'});const p=await f.preview(),saved=process.env.MEDIA_READONLY_FILES;process.env.MEDIA_READONLY_FILES='1';try{await assert.rejects(()=>f.confirm(p),{code:'MANIFEST_READONLY'});}finally{if(saved===undefined)delete process.env.MEDIA_READONLY_FILES;else process.env.MEDIA_READONLY_FILES=saved;}
 f.lib.db.exec("CREATE TABLE metadata_batches(id TEXT PRIMARY KEY,created_ms REAL,status TEXT,payload TEXT)");f.lib.db.prepare("INSERT INTO metadata_batches(id,payload) VALUES(?,?)").run(crypto.randomUUID(),'x'.repeat(131073));await assert.rejects(()=>f.preview(),{code:'REFERENCE_LIMIT'});
});

test('store byte limit is enforced before SELECT of oversized record bodies',async t=>{
 const f=await fixture(t);f.store.insert('cloud_upload_eligibility_cache',{cloudServiceKey:'a'.repeat(64),accountId:crypto.randomUUID(),sha256:'b'.repeat(64),verifiedSourceVersion:null,serverStateVersion:1,admissionEpoch:1,generation:null,checkedAt:1,projection:null});f.lib.db.prepare('UPDATE cloud_upload_eligibility_cache SET record_json=?').run('x'.repeat(524289));const prepare=f.lib.db.prepare.bind(f.lib.db);let bodyRead=false;f.lib.db.prepare=(sql,...args)=>{if(sql.startsWith('SELECT * FROM cloud_upload_eligibility_cache'))bodyRead=true;return prepare(sql,...args);};try{assert.equal(f.store.repairState([f.assetId]).known,false);assert.equal(bodyRead,false);}finally{f.lib.db.prepare=prepare;}
});
test('root journal capacity refuses new prepare without leaving an unrecoverable 65th pending row',async t=>{
 const f=await fixture(t);const insert=f.lib.db.prepare("INSERT INTO asset_repair_journal(operation_id,idempotency_key,canonical_asset_id,from_root_id,to_root_id,phase,version,input_sha256,payload,created_ms,updated_ms) VALUES(?,?,?,?,?,'ABORTED',0,?,'{}',0,0)");for(let i=0;i<64;i++)insert.run(crypto.randomUUID(),crypto.createHash('sha256').update(String(i)).digest('hex'),f.assetId,f.roots[0].id,f.roots[1].id,'a'.repeat(64));await assert.rejects(()=>f.preview(),{code:'REPAIR_LIMIT'});assert.equal(f.lib.db.prepare('SELECT COUNT(*) n FROM asset_repair_journal').get().n,64);assert.equal(repairRootState(f.lib,f.roots[0]).blocked,false);
});
test('prepared markers without their DB journal cannot be overwritten by a fresh preview or inferred committed',async t=>{
 const f=await fixture(t);f.repair.hook=async stage=>{if(stage==='before-transaction')throw Object.assign(Error('controlled'),{code:'CONTROLLED_FAILURE'});};const p=await f.preview(),pending=await f.confirm(p);assert.equal(pending.phase,'PREPARED');f.lib.db.prepare('DELETE FROM asset_repair_journal').run();await assert.rejects(()=>f.preview(),{code:'REPAIR_PENDING'});assert.equal(f.raw().path,f.original);assert.equal((await reconcileRoot(f.lib,f.roots[0],options)).repairPending,true);
});
test('known in-flight or queued metadata workers block restore rather than treating a lock as proof they settled',async t=>{
 const f=await fixture(t),p=await f.preview();f.lib.workers=1;await assert.rejects(()=>f.confirm(p),{code:'BUSY'});f.lib.workers=0;f.lib.metadataPending.add(f.assetId);await assert.rejects(()=>f.confirm(p),{code:'BUSY'});f.lib.metadataPending.clear();assert.equal(f.raw().path,f.original);assert.equal(f.lib.db.prepare('SELECT COUNT(*) n FROM asset_repair_journal').get().n,0);
});
