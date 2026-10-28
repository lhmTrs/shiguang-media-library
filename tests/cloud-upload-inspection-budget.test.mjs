// Only private generated files; actual FileHandle.read/stat/close. No network, model or author library.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {CloudAudioUpload} from '../server/cloud-audio-upload.mjs';
import {createPreviewReadBudget} from '../server/cloud-upload-preview.mjs';
import {sqliteFixture,fixedId} from './cloud-upload-batch-mysql-fixture.mjs';
export const roots=[],deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
export async function inspectionFixture(t=null,sizes=[32]){
 const f=await sqliteFixture(null,[]);roots.push({directory:f.dir,policy:'RETAIN_ALL',atSetup:true});const media=path.join(f.dir,'generated-media');await fs.mkdir(media);const root={id:fixedId(9),path:media,online:1,retired:0},files=new Map();
 f.db.exec('CREATE TABLE assets(id TEXT PRIMARY KEY,root_id TEXT,kind TEXT,category TEXT,sub TEXT,trashed INTEGER,online INTEGER,missing INTEGER)');
 for(let i=0;i<sizes.length;i++){const id=fixedId(100+i),file=path.join(media,`generated-${i}.wav`),handle=await fs.open(file,'wx');try{await handle.truncate(sizes[i]);}finally{await handle.close();}files.set(id,file);f.db.prepare('INSERT INTO assets VALUES(?,?,?,?,?,0,1,0)').run(id,root.id,'music','A','B');}
 let network=0;const auth={epoch:1,getState:()=>({configured:true,state:'logged-in',originHost:'controlled.invalid',accountId:f.who.accountId,deviceId:f.who.deviceId}),async proxy(){network++;throw Error('NETWORK_FORBIDDEN');},async uploadAudioContent(){network++;throw Error('NETWORK_FORBIDDEN');}};
 const lib={db:f.db,dataDir:f.dir,locks:new Set(),asset:id=>f.db.prepare('SELECT * FROM assets WHERE id=?').get(id),rootById:id=>id===root.id?root:undefined,nonMissingAssetScope:()=>'(missing=0)',async source(id){const a=this.asset(id),p=files.get(id);return{a,p,stat:await fs.stat(p)};}};
 const upload=await new CloudAudioUpload(lib,{cloudAuth:auth,enabled:true}).init();f.batches.upload=upload;
 const x={f,lib,root,files,media,upload,auth,get network(){return network;},ids:[...files.keys()],async close(){assert.equal((await upload.dispose({timeoutMs:1000})).closed,true);assert.equal(network,0);if(f.db.open)f.db.close();}};t?.after(()=>x.close());return x;
}
export function watchReads(t,x,{short,afterRead,beforeRead,beforeClose,failClose=false}={}){
 const original=fs.open,stats={bytes:0,reads:0,opens:0,closed:0,active:new Set(),lengths:[],events:[]};const known=new Set(x.files.values());
 fs.open=async(file,...args)=>{const h=await original(file,...args);if(known.has(String(file))){stats.opens++;stats.active.add(h);const read=h.read.bind(h),close=h.close.bind(h);
  h.read=async(buffer,offset,length,position)=>{if(beforeRead)await beforeRead(h);const selected=short?Math.min(length,short):length;const result=await read(buffer,offset,selected,position);stats.bytes+=result.bytesRead;stats.reads++;stats.lengths.push(selected);stats.events.push('actual-read-settled');if(afterRead)await afterRead(result,h);return result;};
  h.close=async()=>{stats.events.push('close-enter');if(beforeClose)await beforeClose(h);if(failClose)throw Object.assign(Error('controlled close failure'),{code:'EIO'});await close();stats.closed++;stats.active.delete(h);assert.equal(h.fd,-1);stats.events.push('actual-close-settled');};
 }return h;};
 t?.after(()=>{fs.open=original;});return{stats,restore(){fs.open=original;}};
}
const main=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(main&&process.argv[2]==='close-unknown-child'){
 const x=await inspectionFixture(null,[32]),w=watchReads(null,x,{failClose:true});const error=await x.upload.inspectForBatch(x.ids[0],{budget:createPreviewReadBudget()}).catch(e=>e);assert.equal(error.code,'SOURCE_CHANGED');assert.equal(x.upload.operations.size,1);assert.equal(x.upload.inspections.size,1);assert.equal((await x.upload.dispose({timeoutMs:0})).closed,false);assert.equal(w.stats.active.size,1);assert.equal(x.f.db.open,true);w.restore();console.log('UQ04B2_UNKNOWN='+JSON.stringify({root:x.f.dir,closed:false,unknown:true,dbKept:true,handleRegistryKept:true,policy:'No forced close/removal; isolated child naturally exits'}));
}else if(main){
 test.after(()=>console.log('UQ04B2_INSPECTION_ROOTS='+JSON.stringify({roots,after:'No after filesystem scan/removal; normal known handles closed; unknown child retains registry until natural process exit'})));
 test('short actual reads charge returned bytes only and use a shared nonreset budget',async t=>{
  const x=await inspectionFixture(t,[7,9]),w=watchReads(t,x,{short:3}),budget=createPreviewReadBudget({maxBytes:16});
  const a=await x.upload.inspectForBatch(x.ids[0],{budget}),b=await x.upload.inspectForBatch(x.ids[1],{budget});assert.equal(a.sha256,crypto.createHash('sha256').update(Buffer.alloc(7)).digest('hex'));assert.equal(b.sha256,crypto.createHash('sha256').update(Buffer.alloc(9)).digest('hex'));assert.equal(budget.state().bytesRead,16);assert.equal(w.stats.bytes,16);assert.equal(w.stats.opens,w.stats.closed);assert.equal(x.upload.operations.size,0);assert.equal(x.upload.jobs.length,0);
 });
 test('an undersized budget reads the actual remainder then fails without precharging stat size or overshooting',async t=>{
  const x=await inspectionFixture(t,[7,9]),w=watchReads(t,x),budget=createPreviewReadBudget({maxBytes:15});await x.upload.inspectForBatch(x.ids[0],{budget});await assert.rejects(x.upload.inspectForBatch(x.ids[1],{budget}),{code:'PREVIEW_BUDGET_EXCEEDED'});assert.equal(budget.state().bytesRead,15);assert.equal(w.stats.bytes,15);assert.deepEqual(w.stats.lengths,[7,8]);assert.equal(w.stats.closed,2);assert.equal(x.upload.inspections.size,0);
 });
 test('monotonic deadline during a real read waits for the actual read and close, never Promise-races it away',async t=>{
  const x=await inspectionFixture(t,[32]),entered=deferred(),release=deferred();let now=10,settled=false;const budget=createPreviewReadBudget({now:()=>now}),w=watchReads(t,x,{afterRead:async()=>{entered.resolve();await release.promise;}}),work=x.upload.inspectForBatch(x.ids[0],{budget}).then(()=>{settled=true;return null;},e=>{settled=true;return e;});
  await entered.promise;now=10011;await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.equal(x.upload.operations.size,1);assert.equal(w.stats.active.size,1);release.resolve();const error=await work;assert.equal(error.code,'PREVIEW_BUDGET_EXCEEDED');assert.equal(budget.state().bytesRead,32);assert.equal(w.stats.closed,1);assert.equal(x.upload.operations.size,0);
 });
 test('budgeted reads use the monotonic deadline even when wall clock jumps forward',async t=>{
  const x=await inspectionFixture(t,[32]),originalNow=Date.now,wall=Date.now();const w=watchReads(t,x,{afterRead:async()=>{Date.now=()=>wall+1000000000;}}),budget=createPreviewReadBudget({now:()=>100});
  try{const result=await x.upload.inspectForBatch(x.ids[0],{budget});assert.equal(result.declaredBytes,32);assert.equal(budget.state().expired,false);assert.equal(w.stats.bytes,32);}finally{Date.now=originalNow;}
 });
 test('abort while fh.close is pending retains operation/repair guards and dispose reports unknown until close really ends',async t=>{
  const x=await inspectionFixture(t,[32]),controller=new AbortController(),entered=deferred(),release=deferred();let settled=false;const w=watchReads(t,x,{beforeClose:async()=>{entered.resolve();await release.promise;}}),work=x.upload.inspectForBatch(x.ids[0],{budget:createPreviewReadBudget(),signal:controller.signal}).then(()=>{settled=true;return null;},e=>{settled=true;return e;});
  await entered.promise;assert.equal(x.upload.repairMemoryState(x.ids).state,'blocked');controller.abort();assert.equal((await x.upload.dispose({timeoutMs:0})).closed,false);assert.equal(settled,false);assert.equal(x.upload.operations.size,1);assert.equal(w.stats.active.size,1);release.resolve();assert.equal((await work).code,'PREVIEW_CANCELLED');assert.equal(w.stats.closed,1);assert.equal(x.upload.operations.size,0);assert.equal((await x.upload.dispose()).closed,true);
 });
 test('source changed on disk and identity changed across actual read both reject without intent writes',async t=>{
  for(const mode of ['source','identity']){const x=await inspectionFixture(t,[32]);let once=true;const w=watchReads(t,x,{afterRead:async()=>{if(once){once=false;if(mode==='source')await fs.appendFile(x.files.get(x.ids[0]),Buffer.from([1]));else x.auth.epoch++;}}});
   try{await assert.rejects(x.upload.inspectForBatch(x.ids[0],{budget:createPreviewReadBudget()}),{code:mode==='source'?'SOURCE_CHANGED':'AUTH_CHANGED'});assert.equal(x.upload.jobs.length,0);assert.equal(w.stats.closed,1);}finally{w.restore();}
  }
 });
 test('cancellation after source lookup prevents opening a file and a zero short read cannot fabricate a digest',async t=>{
  const x=await inspectionFixture(t,[32]),controller=new AbortController(),original=x.lib.source.bind(x.lib),w=watchReads(t,x);x.lib.source=async id=>{const v=await original(id);controller.abort();return v;};await assert.rejects(x.upload.inspectForBatch(x.ids[0],{budget:createPreviewReadBudget(),signal:controller.signal}),{code:'PREVIEW_CANCELLED'});assert.equal(w.stats.opens,0);x.lib.source=original;w.restore();
  const open=fs.open;fs.open=async(file,...args)=>{const h=await open(file,...args);if(String(file)===x.files.get(x.ids[0]))h.read=async()=>({bytesRead:0});return h;};try{await assert.rejects(x.upload.inspectForBatch(x.ids[0],{budget:createPreviewReadBudget()}),{code:'SOURCE_CHANGED'});assert.equal(x.upload.operations.size,0);}finally{fs.open=open;}
 });
 test('shared read reservations bound concurrent actual reads without precharging entire files',async t=>{
  const x=await inspectionFixture(t,[8,8]),budget=createPreviewReadBudget({maxBytes:8}),entered=deferred(),release=deferred(),w=watchReads(t,x,{afterRead:async()=>{entered.resolve();await release.promise;}});const first=x.upload.inspectForBatch(x.ids[0],{budget});const handled=first.catch(e=>e);await entered.promise;assert.equal(budget.state().bytesRead,0);assert.equal(budget.state().reservedBytes,8);
  try{await assert.rejects(x.upload.inspectForBatch(x.ids[1],{budget}),{code:'PREVIEW_BUDGET_EXCEEDED'});assert.equal(w.stats.bytes,8);}finally{release.resolve();}assert.equal((await handled).declaredBytes,8);assert.equal(budget.state().bytesRead,8);assert.equal(budget.state().reservedBytes,0);
 });
 test('normal no-options inspection and original manual prepare keep their own semantics',async t=>{
  const x=await inspectionFixture(t,[4096,129*1024*1024]);const large=await x.upload.inspectForBatch(x.ids[1]);assert.equal(large.declaredBytes,129*1024*1024);const view=await x.upload.inspectForBatch(x.ids[0]);assert.equal(view.declaredBytes,4096);assert.equal(x.upload.jobs.length,0);const prepared=await x.upload.prepare({assetId:x.ids[0],mediaKind:'MUSIC',visibility:'PRIVATE',groupId:null,category:'A',subcategory:'B'});assert.equal(prepared.state,'prepared');assert.equal(prepared.bytes,4096);assert.equal(x.upload.jobs.length,1);assert.equal((await fs.stat(path.join(x.upload.dir,`payload-${prepared.id}`))).size,4096);assert.equal(x.network,0);
 });
 test('unconfirmed file-close failure retains the actual handle registry and cannot fake disposed',async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(import.meta.url),'close-unknown-child'],{timeout:5000,maxBuffer:65536});const line=stdout.split('\n').find(v=>v.startsWith('UQ04B2_UNKNOWN='));assert.ok(line);const evidence=JSON.parse(line.slice('UQ04B2_UNKNOWN='.length));assert.equal(evidence.closed,false);assert.equal(evidence.handleRegistryKept,true);roots.push({directory:evidence.root,policy:'RETAIN_ALL',unknownChildNaturallyExited:true});console.log('UQ04B2_UNKNOWN_EVIDENCE='+JSON.stringify(evidence));
 });
}
