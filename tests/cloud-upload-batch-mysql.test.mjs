// Opt-in only: UQ01_MYSQL_TEST=1. No existing database/configuration is consulted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import {startOwnedMysql,casPeer} from './cloud-upload-batch-mysql-env.mjs';
import {MysqlDatabase} from '../server/mysql-db.mjs';
import {MysqlStorage} from '../server/mysql.mjs';
import {CloudUploadBatchStore,UPLOAD_TABLES,sqlName,uploadOrderBy} from '../server/cloud-upload-batch-store.mjs';
import {CloudUploadPreview} from '../server/cloud-upload-preview.mjs';
import {CloudUploadBatches} from '../server/cloud-upload-batches.mjs';
import {uuid,canonical,fingerprint} from '../server/cloud-upload-protocol.mjs';
import {rows,fixedId,fakeUpload} from './cloud-upload-batch-mysql-fixture.mjs';
const enabled=process.env.UQ01_MYSQL_TEST==='1';
const evidence=process.env.UQ01_MYSQL_EVIDENCE;
const digest=file=>fs.readFile(file).then(v=>crypto.createHash('sha256').update(v).digest('hex'));
function fixture(db,source=rows(6).map(r=>({...r,fileName:"合成'音频.wav",category:'音乐',subcategory:'氛围'}))){
 const who={cloudServiceKey:'b'.repeat(64),accountId:fixedId(1),deviceId:fixedId(2),librarySourceId:fixedId(3),epoch:1};
 const store=new CloudUploadBatchStore(db).init(),upload=fakeUpload();
 const preview=new CloudUploadPreview(store,{currentIdentity:()=>who,snapshotScope:async()=>({scanComplete:true,offline:false,rootRevision:1,scanCompletedAt:100,items:source})});
 const batches=new CloudUploadBatches(store,preview,{currentIdentity:()=>who,upload,authorize:async()=>({canCreateUploads:true,classification:'NEW'})});
 const input=()=>({clientCommandId:uuid(),scopes:[{rootId:fixedId(9),category:null,subcategory:null}],target:{visibility:'PRIVATE',groupId:null},categoryOverride:null});
 return{who,store,upload,preview,batches,input,async create(){const p=await preview.create(who,input()),request={clientCommandId:uuid(),previewId:p.previewId,expectedPreviewVersion:p.version,manifestFingerprint:p.manifestFingerprint,startPaused:false,representativeConfirmations:[]},b=batches.create(who,request);return{p,b,request,items:batches.rows(b.batchId)};},receipt(r,a){return{receiptId:uuid(),clientRequestId:a.clientRequestId,canonicalRequestId:uuid(),attemptId:uuid(),blobId:uuid(),shareId:uuid(),sha256:r.sha256,verifiedBytes:r.declaredBytes,storageGeneration:1,admissionEpoch:0,mode:'uploaded',targetMatched:true,committedAt:'2026-10-26T00:00:00Z',currentAvailability:'AVAILABLE'};}};
}
function basicSource(file){
 const db=new Database(file);
 // Minimum legal original migration tables; synthetic metadata only, no scanner/importer.
 db.exec('CREATE TABLE roots(id TEXT PRIMARY KEY,path TEXT,name TEXT);CREATE TABLE assets(id TEXT PRIMARY KEY,path TEXT,root_id TEXT,created_ms INTEGER,captured_ms INTEGER);CREATE TABLE operations(id TEXT PRIMARY KEY,action TEXT)');
 db.prepare('INSERT INTO roots VALUES(?,?,?)').run(uuid(),'/synthetic/nonexistent/root','fixture');
 return{db,locks:new Set(),jobs:new Map(),workers:0,migrating:false,pump(){}};
}
function summaries(db){return Object.fromEntries(Object.keys(UPLOAD_TABLES).map(table=>{const data=db.prepare('SELECT * FROM '+table+' ORDER BY '+uploadOrderBy(table)).all();return[table,{count:data.length,hash:fingerprint(data)}];}));}
test('UQ01 real MySQL8.4 worker/store and original migration (explicit owned environment)',{skip:!enabled},async t=>{
 const env=await startOwnedMysql(),results={server:env.inventory.server,scenarios:[],inventory:env.inventory};
 try{
  await t.test('real schema, constraints, durable commands, CAS, rollback and two-worker stale updates',async()=>{
   const database=await env.schema('direct');let db=new MysqlDatabase(env.config(database));
   try{
    const f=fixture(db),{p,b,request,items}=await f.create();assert.equal(db.kind,'mysql');assert.equal(f.preview.rows(p.previewId)[0].fileName,"合成'音频.wav");const session=db.prepare('SELECT @@sql_mode sqlMode,@@transaction_isolation isolation').get();
    const tables=db.prepare("SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME").all(database);assert.equal(tables.length,8);assert.ok(tables.every(r=>r.ENGINE==='InnoDB'));
    const columns=db.prepare('SELECT TABLE_NAME,COLUMN_NAME,DATA_TYPE,CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=?').all(database);
    for(const [table,spec]of Object.entries(UPLOAD_TABLES))for(const [key,col]of Object.entries(spec.columns)){
     const actual=columns.find(r=>r.TABLE_NAME===table&&r.COLUMN_NAME===sqlName(key));assert.ok(actual);
     assert.equal(actual.DATA_TYPE,col.type.split('(')[0].toLowerCase());
     if(/^(VARCHAR|CHAR)/.test(col.type))assert.equal(Number(actual.CHARACTER_MAXIMUM_LENGTH),Number(col.type.match(/\d+/)[0]));
    }
    const constraints=db.prepare('SELECT TABLE_NAME,CONSTRAINT_TYPE,COUNT(*) n FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=? GROUP BY TABLE_NAME,CONSTRAINT_TYPE').all(database);
    for(const table of Object.keys(UPLOAD_TABLES)){assert.ok(constraints.some(r=>r.TABLE_NAME===table&&r.CONSTRAINT_TYPE==='PRIMARY KEY'));assert.ok(constraints.some(r=>r.TABLE_NAME===table&&r.CONSTRAINT_TYPE==='CHECK'));}
    const failures=[];
    for(const value of [-1,9007199254740992])assert.throws(()=>db.prepare('UPDATE cloud_upload_batches SET version=? WHERE batch_id=?').run(value,b.batchId),e=>{failures.push(e.code);return e.code==='ER_CHECK_CONSTRAINT_VIOLATED';});
    assert.throws(()=>db.prepare("UPDATE cloud_upload_batches SET state='INVALID' WHERE batch_id=?").run(b.batchId),e=>{failures.push(e.code);return e.code==='ER_CHECK_CONSTRAINT_VIOLATED';});
    assert.deepEqual(f.batches.create(f.who,request),b);
    assert.throws(()=>f.batches.create(f.who,{...request,startPaused:true}),{code:'IDEMPOTENCY_CONFLICT'});
    assert.throws(()=>f.store.insert('cloud_upload_batches',{...f.store.get('cloud_upload_batches',{batchId:b.batchId}),batchId:uuid()}),e=>{failures.push(e.code);return e.code==='ER_DUP_ENTRY';});
    const command=f.store.get('cloud_upload_commands',{cloudServiceKey:f.who.cloudServiceKey,accountId:f.who.accountId,clientCommandId:request.clientCommandId});assert.throws(()=>f.store.insert('cloud_upload_commands',command),e=>{failures.push(e.code);return e.code==='ER_DUP_ENTRY';});
    const before=f.store.get('cloud_upload_batches',{batchId:b.batchId});
    assert.throws(()=>f.store.transaction(()=>{f.store.update('cloud_upload_batches',before,{state:'PAUSED'});throw Error('synthetic rollback');}),/synthetic rollback/);assert.equal(f.store.get('cloud_upload_batches',{batchId:b.batchId}).version,before.version);
    f.batches.beginAttempt(f.who,items[0].itemId);const claim=f.store.list('cloud_upload_active_claims',{itemId:items[0].itemId})[0];assert.throws(()=>f.store.insert('cloud_upload_active_claims',{...claim,itemId:uuid()}),e=>{failures.push(e.code);return e.code==='ER_DUP_ENTRY';});const other=await f.create();assert.throws(()=>f.batches.beginAttempt(f.who,other.items[0].itemId),{code:'ACTIVE_ITEM_EXISTS'});
    const peers=[casPeer(env.config(database)),casPeer(env.config(database))];
    try{for(const peer of peers)assert.equal((await peer.send({action:'read',batchId:b.batchId})).version,b.version);assert.equal((await peers[0].send({action:'update'})).ok,true);assert.deepEqual(await peers[1].send({action:'update'}),{ok:false,code:'VERSION_CONFLICT'});}finally{for(const peer of peers)await peer.close(env.inventory.workers);}
    await env.closeDb(db);db=new MysqlDatabase(env.config(database));assert.equal(fixture(db).store.get('cloud_upload_batches',{batchId:b.batchId}).state,'PAUSED');
    results.scenarios.push({name:'schema-commands-cas',status:'PASS',session,utf8AndQuoteRoundtrip:true,tables:tables.length,columns:columns.length,constraints,sqlErrors:failures});
   }finally{await env.closeDb(db);}
  });
  await t.test('real MySQL ordinal filtering, independent group proofs and receipt reconnect cleanup',async()=>{
   const database=await env.schema('behavior');let db=new MysqlDatabase(env.config(database));
   try{
    const source=rows(120);source[0].sha256=source[100].sha256='a'.repeat(64);source[0].fileName='A.wav';source[100].fileName='A2.wav';source[1].sha256=source[101].sha256='c'.repeat(64);source[1].fileName='B.wav';source[101].fileName='B2.wav';
    let f=fixture(db,source),p=await f.preview.create(f.who,f.input());
    for(const r of f.preview.rows(p.previewId).slice(0,50))f.preview.cacheEligibility(f.who,r.sha256,r.sourceVersion,{classification:'UPLOADED',serverStateVersion:1,admissionEpoch:0});
    let page=f.preview.page(f.who,p.previewId,{scanBudget:50});assert.equal(page.items.length,0);assert.ok(page.nextCursor);const seen=[];
    while(page.nextCursor){page=f.preview.page(f.who,p.previewId,{cursor:page.nextCursor,scanBudget:50});seen.push(...page.items.map(r=>r.ordinal));}assert.ok(seen.includes(119));assert.equal(new Set(seen).size,seen.length);
    function confirm(index){const g=f.preview.group(f.who,p.previewId,source[index].sha256,source[index].assetId);p=f.preview.selection(f.who,p.previewId,{clientCommandId:uuid(),expectedVersion:p.version,changes:[],representatives:[{sha256:g.sha256,representativeAssetId:g.representativeAssetId,expectedGroupVersion:g.groupVersion,confirmedFingerprint:g.fingerprint}]});}
    confirm(0);const A=f.preview.group(f.who,p.previewId,source[0].sha256);confirm(101);assert.deepEqual(f.preview.group(f.who,p.previewId,source[0].sha256),A);
    p=f.preview.selection(f.who,p.previewId,{clientCommandId:uuid(),expectedVersion:p.version,changes:[{assetId:source[3].assetId,included:false}],representatives:[]});assert.deepEqual(f.preview.group(f.who,p.previewId,source[0].sha256),A);
    const b=f.batches.create(f.who,{clientCommandId:uuid(),previewId:p.previewId,expectedPreviewVersion:p.version,manifestFingerprint:p.manifestFingerprint,startPaused:false,representativeConfirmations:[]}),r=f.batches.rows(b.batchId)[0];
    await f.batches.prepareItem(f.who,r.itemId);const current=f.store.get('cloud_upload_batch_items',{itemId:r.itemId}),a=f.store.get('cloud_upload_item_attempts',{attemptId:current.currentAttemptId}),receipt=f.receipt(current,a);
    f.batches.upload.forgetVerified=async()=>{throw Error('synthetic module cleanup failure');};assert.equal((await f.batches.recordReceipt(f.who,r.itemId,a.attemptId,receipt)).cleanupPending,true);
    await env.closeDb(db);db=new MysqlDatabase(env.config(database));f=fixture(db,source);f.batches.recover(f.who);assert.equal(f.store.get('cloud_upload_batch_items',{itemId:r.itemId}).currentAttemptId,a.attemptId);
    await f.batches.recordReceipt(f.who,r.itemId,a.attemptId,{...receipt,currentAvailability:'ADMIN_DELETED'});const final=f.store.get('cloud_upload_batch_items',{itemId:r.itemId});assert.equal(final.cleanupPending,false);assert.equal(final.receipt.receiptId,receipt.receiptId);assert.equal(final.currentAvailability.state,'ADMIN_DELETED');assert.equal(Object.hasOwn(final.receipt,'currentAvailability'),false);
    results.scenarios.push({name:'ordinal-groups-receipt-reconnect',status:'PASS',scannedTo:119,receiptBeforeForget:true});
   }finally{await env.closeDb(db);}
  });
  await t.test('original MysqlStorage.activate migrates eight upload tables with original source and digest intact',async()=>{
   const database=await env.schema('migration'),dir=path.join(env.directory,'source');await fs.mkdir(dir);const file=path.join(dir,'library.sqlite'),lib=basicSource(file),storage=await new MysqlStorage(dir).init();storage.attach(lib);
   let sqlite=lib.db;
   try{
    const synthetic=rows(12).map(r=>({...r,fileName:"合成'音频.wav",category:'音乐',subcategory:'氛围',sourceVersion:{...r.sourceVersion,ino:9007199254740990,mtimeMs:100.125}}));
    const f=fixture(sqlite,synthetic),{p,b,items}=await f.create();await f.batches.prepareItem(f.who,items[0].itemId);const r=f.store.get('cloud_upload_batch_items',{itemId:items[0].itemId}),a=f.store.get('cloud_upload_item_attempts',{attemptId:r.currentAttemptId});await f.batches.recordReceipt(f.who,r.itemId,a.attemptId,f.receipt(r,a));f.preview.cacheEligibility(f.who,r.sha256,r.sourceVersion,{classification:'NEW',serverStateVersion:9007199254740990,admissionEpoch:0});
    // Multi-row, non-insertion ordering and integer ordinals with the same leading PK.
    for(const [n,action] of [[2010,'pause'],[2002,'resume'],[2001,'pause']])f.batches.command(f.who,b.batchId,{clientCommandId:fixedId(n),expectedVersion:f.store.get('cloud_upload_batches',{batchId:b.batchId}).version,action});
    for(const [i,value] of [9007199254740990,9007199254740991,42].entries())f.preview.cacheEligibility(f.who,synthetic[i].sha256,synthetic[i].sourceVersion,{classification:'NEW',serverStateVersion:value,admissionEpoch:0});
    f.store.transaction(()=>{
     for(const table of ['cloud_upload_preview_items','cloud_upload_batch_items','cloud_upload_commands','cloud_upload_eligibility_cache']){
      const saved=f.store.list(table),ordered=table.endsWith('_items')?[...saved.filter(x=>[10,2,1].includes(x.ordinal)).sort((a,b)=>[10,2,1].indexOf(a.ordinal)-[10,2,1].indexOf(b.ordinal)),...saved.filter(x=>![10,2,1].includes(x.ordinal)).reverse()]:saved.reverse();
      sqlite.exec('DELETE FROM '+table);for(const row of ordered)f.store.insert(table,row);
     }
    });
    for(const n of [10,2,1]){
     const rootId=fixedId(3000+n),assetId=fixedId(4000+n);sqlite.prepare('INSERT INTO roots VALUES(?,?,?)').run(rootId,'/synthetic/root/'+n,'root-'+n);
     sqlite.prepare('INSERT INTO assets VALUES(?,?,?,?,?)').run(assetId,'/synthetic/asset/'+n,rootId,9007199254740990,n);
     sqlite.prepare('INSERT INTO operations VALUES(?,?)').run(fixedId(5000+n),'synthetic-'+n);
    }
    const orderedPreview=sqlite.prepare('SELECT ordinal FROM cloud_upload_preview_items WHERE preview_id=? ORDER BY preview_id,ordinal').all(p.previewId).map(r=>r.ordinal);assert.deepEqual(orderedPreview,Array.from({length:12},(_,i)=>i));
    const legacy=Object.fromEntries(['roots','assets','operations'].map(table=>{const columns=sqlite.prepare('PRAGMA table_info('+table+')').all().map(c=>c.name);return[table,{columns,rows:sqlite.prepare('SELECT '+columns.join(',')+' FROM '+table+' ORDER BY id').all()}];}));
    const sourceId=storage.sourceId,before=await digest(file),counts=summaries(sqlite);
    try{await storage.activate(env.config(database));}catch(error){
     assert.equal(lib.db,sqlite);assert.equal(sqlite.open,true);assert.equal(await digest(file),before);assert.equal(storage.sourceId,sourceId);assert.equal(storage.database,null);await assert.rejects(fs.stat(storage.configPath),{code:'ENOENT'});
     const connection=await env.connection(database);let detail;
     try{await connection.query('SELECT preview_id FROM cloud_upload_previews ORDER BY id');}catch(e){detail={code:e.code,errno:e.errno,sql:'SELECT preview_id FROM cloud_upload_previews ORDER BY id'};}finally{await connection.end();}
     results.scenarios.push({name:'original-storage-migration',status:'FAIL',productError:error.message,detail,sourceUnchanged:true,sourceIdentityUnchanged:true,targetNotActivated:true});throw error;
    }
    assert.equal(sqlite.open,false);sqlite=null;assert.equal(lib.db.kind,'mysql');assert.deepEqual(summaries(lib.db),counts);for(const [table,snapshot]of Object.entries(legacy))assert.deepEqual(lib.db.prepare('SELECT '+snapshot.columns.join(',')+' FROM '+table+' ORDER BY id').all(),snapshot.rows);assert.equal(await digest(file),before);assert.equal(storage.sourceId,sourceId);
    await env.closeDb(storage.database);storage.database=null;
    const reopened=await new MysqlStorage(dir).init();try{assert.equal(reopened.database.kind,'mysql');assert.deepEqual(summaries(reopened.database),counts);const persisted=fixture(reopened.database,synthetic);assert.deepEqual(persisted.store.get('cloud_upload_batch_items',{itemId:r.itemId}).receipt.receiptId,persisted.store.get('cloud_upload_item_attempts',{attemptId:a.attemptId}).receiptId);assert.equal(reopened.database.prepare('SELECT MAX(server_state_version) v FROM cloud_upload_eligibility_cache').get().v,9007199254740991);}finally{await env.closeDb(reopened.database);}
    results.scenarios.push({name:'original-storage-migration',status:'PASS',counts,sourceUnchanged:true,sourceIdentityUnchanged:true,ordinalOrder:orderedPreview,compositeCommands:counts.cloud_upload_commands.count,legacyTables:['roots','assets','operations'],maxSafeInteger:9007199254740991,actualReconnection:true});
   }finally{if(storage.database)await env.closeDb(storage.database);if(sqlite?.open)sqlite.close();}
  });
  await t.test('original migration refuses a foreign-owned synthetic target and preserves source/config',async()=>{
   const database=await env.schema('wrong_owner'),conn=await env.connection(database);try{await conn.query('CREATE TABLE shiguang_database_meta(id INT PRIMARY KEY,source_id VARCHAR(36),schema_version INT)');await conn.execute('INSERT INTO shiguang_database_meta VALUES(1,?,1)',[uuid()]);}finally{await conn.end();}
   const dir=path.join(env.directory,'rejected-source');await fs.mkdir(dir);const file=path.join(dir,'library.sqlite'),lib=basicSource(file),storage=await new MysqlStorage(dir).init();storage.attach(lib);
   try{const before=await digest(file),id=storage.sourceId;await assert.rejects(storage.activate(env.config(database)),/其他素材库/);assert.equal(lib.db.kind,undefined);assert.equal(lib.db.open,true);assert.equal(await digest(file),before);assert.equal(storage.sourceId,id);assert.equal(storage.database,null);await assert.rejects(fs.stat(storage.configPath),{code:'ENOENT'});results.scenarios.push({name:'wrong-owner-rejection',status:'PASS',sourceUnchanged:true,configurationNotWritten:true});}finally{lib.db.close();}
  });
 }finally{
  try{await env.finish();}catch(error){results.cleanupError=error.message;env.inventory.cleanup='RETAINED_UNKNOWN';throw error;}finally{if(evidence){await fs.mkdir(evidence,{recursive:true});await fs.writeFile(path.join(evidence,'actual-results.json'),JSON.stringify(results,null,2));}}
 }
});

import os from 'node:os';
test('UQ01 helper preserves replaced/symlink/unknown roots and startup diagnostics (explicit owned environments)',{skip:!enabled},async t=>{
 const checks=[];
 try{
  for(const kind of ['replacement','symlink','unknown'])await t.test(kind+' preserves bytes and always restores environment',async()=>{
   const oldData=process.env.MEDIA_DATA_DIR,oldSkip=process.env.MEDIA_SKIP_IMPORT,env=await startOwnedMysql(),original=env.directory,moved=original+'-test-original';
   let finished=false,target=null;
   try{
    await fs.writeFile(path.join(original,'unregistered-synthetic.txt'),'keep-original');
    if(kind==='replacement'){
     await fs.rename(original,moved);await fs.mkdir(original,{mode:0o700});await fs.writeFile(path.join(original,'foreign-synthetic.txt'),'keep-replacement');
    }else if(kind==='symlink'){
     await fs.rename(original,moved);target=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'uq01-foreign-synthetic-')));await fs.writeFile(path.join(target,'foreign-synthetic.txt'),'keep-symlink-target');await fs.symlink(target,original,'dir');
    }else await fs.chmod(original,0o000);
    await env.finish();finished=true;
    assert.equal(env.inventory.cleanup,'OWN_CONTAINER_REMOVED_TEMP_RETAINED');
    assert.equal(env.inventory.rootObservation.state,{replacement:'REPLACED_RETAINED',symlink:'SYMLINK_RETAINED',unknown:'UNKNOWN_RETAINED'}[kind]);
    assert.equal(process.env.MEDIA_DATA_DIR,oldData);assert.equal(process.env.MEDIA_SKIP_IMPORT,oldSkip);
    if(kind==='replacement')assert.equal(await fs.readFile(path.join(original,'foreign-synthetic.txt'),'utf8'),'keep-replacement');
    if(kind==='symlink'){assert.equal((await fs.lstat(original)).isSymbolicLink(),true);assert.equal(await fs.readFile(path.join(target,'foreign-synthetic.txt'),'utf8'),'keep-symlink-target');}
   }finally{
    if(kind==='unknown'){
     const observed=await fs.lstat(original);if(observed.dev===env.inventory.rootIdentity.dev&&observed.ino===env.inventory.rootIdentity.ino)await fs.chmod(original,env.inventory.rootIdentity.mode);
    }
    if(!finished)await env.finish();
    checks.push({kind,inventory:env.inventory,retainedOriginal:kind==='unknown'?original:moved,retainedSymlinkTarget:target});
   }
   assert.equal(await fs.readFile(path.join(kind==='unknown'?original:moved,'unregistered-synthetic.txt'),'utf8'),'keep-original');
  });
  await t.test('startup failure never writes diagnostic inventory into a replaced root',async()=>{
   const oldPath=process.env.PATH,oldData=process.env.MEDIA_DATA_DIR,oldSkip=process.env.MEDIA_SKIP_IMPORT;
   const privateBin=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'uq01-startup-counter-'))),wrapper=path.join(privateBin,'docker');
   assert.ok(!/\s/.test(process.execPath),'test fixture shebang needs a whitespace-free Node path');
   await fs.writeFile(wrapper,'#!'+process.execPath+'\n'+"const fs=require('node:fs');const p=process.env.MEDIA_DATA_DIR;fs.renameSync(p,p+'-startup-original');fs.mkdirSync(p,{mode:0o700});fs.writeFileSync(p+'/foreign-synthetic.txt','keep-startup');process.exit(7);\n",{mode:0o700});
   let diagnostic;
   try{
    process.env.PATH=privateBin+path.delimiter+oldPath;
    await assert.rejects(startOwnedMysql(),error=>{diagnostic=error.inventory;return diagnostic?.cleanup==='RETAINED_STARTUP_FAILURE';});
    assert.equal(diagnostic.containerId,null);assert.equal(diagnostic.rootObservation.state,'REPLACED_RETAINED');assert.equal(diagnostic.environmentRestored,true);
    assert.equal(await fs.readFile(path.join(diagnostic.directory,'foreign-synthetic.txt'),'utf8'),'keep-startup');
    await assert.rejects(fs.stat(path.join(diagnostic.directory,'inventory.json')),{code:'ENOENT'});
    assert.equal(process.env.MEDIA_DATA_DIR,oldData);assert.equal(process.env.MEDIA_SKIP_IMPORT,oldSkip);
   }finally{if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;checks.push({kind:'startup-failure-injection',inventory:diagnostic,retainedWrapper:privateBin});}
  });
 }finally{if(evidence){await fs.mkdir(evidence,{recursive:true});await fs.writeFile(path.join(evidence,'root-preservation-results.json'),JSON.stringify({checks,policy:'RETAIN_ALL_TEMPORARY_FILES'},null,2));}}
});
