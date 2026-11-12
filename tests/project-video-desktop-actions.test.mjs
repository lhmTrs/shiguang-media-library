import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {ProjectVideoDesktopNative} from '../server/project-videos/desktop-native.mjs';
import {fixture,imported,finish,initialize,bind,appendXmp,replaceBytes} from './helpers/project-video-desktop-fixture.mjs';

test('C: XMP-only byte drift keeps source, metadata, prompt and precise adopts; changed pixels do not',async t=>{
  const f=await fixture(t),source=await imported(f);initialize(f);await bind(f,source);
  const meta=f.catalog.metadata(f.project.id,source),before=f.entry.store.baseState(f.project.id);
  assert.ok(meta.data.contentFingerprint);
  await appendXmp(source);
  const refreshed=await f.catalog.verifiedSource(f.project.id,source.id),after=f.entry.store.baseState(f.project.id),data=f.catalog.metadata(f.project.id,refreshed).data;
  assert.equal(refreshed.id,source.id);assert.equal(data.title,meta.data.title);assert.equal(data.notes,meta.data.notes);assert.equal(data.promptId,meta.data.promptId);assert.notEqual(data.sha256,meta.data.sha256);assert.deepEqual(after.plan,before.plan);assert.deepEqual(after.takes,before.takes);
  assert.deepEqual(f.catalog.verification.view(refreshed),{state:'verified',match:'media',metadataChanged:true});
  assert.equal((await f.catalog.list(f.project.id)).videos[0].verification.metadataChanged,true);
  await replaceBytes(f,refreshed);await assert.rejects(f.catalog.verifiedSource(f.project.id,source.id),e=>e.code==='SOURCE_CHANGED');
  assert.deepEqual(f.entry.store.baseState(f.project.id).plan,before.plan);
});

test('A: partial selection, stable order, repeat receipt and changed request conflict; no native replay',async t=>{
  const f=await fixture(t),one=await imported(f),two=await imported(f);
  await fs.unlink(two.path);const request={requestId:randomUUID(),ids:[one.id,two.id,one.id,randomUUID()]};
  const first=f.catalog.desktop.clipboard(f.project.id,request);assert.equal(first.status,'checking');
  const result=await finish(f,first);assert.equal(result.status,'partial');assert.equal(result.count,1);assert.equal(result.requestedCount,3);assert.equal(result.copied[0].id,one.id);assert.equal(result.skipped.length,2);
  assert.equal(f.native.copies.length,1);assert.deepEqual(f.catalog.desktop.clipboard(f.project.id,request),result);assert.equal(f.native.copies.length,1);
  assert.throws(()=>f.catalog.desktop.clipboard(f.project.id,{...request,ids:[two.id]}),e=>e.code==='REQUEST_ID_CONFLICT');
  assert.throws(()=>f.catalog.desktop.clipboard(f.other.id,request),e=>e.code==='REQUEST_ID_CONFLICT');
});

test('A: zero valid files preserves clipboard; file URLs cannot be supplied in a request',async t=>{
  const f=await fixture(t);const result=await finish(f,f.catalog.desktop.clipboard(f.project.id,{requestId:randomUUID(),ids:[randomUUID()]}));
  assert.equal(result.count,0);assert.equal(result.status,'failed');assert.equal(f.native.copies.length,0);
  assert.throws(()=>f.catalog.desktop.clipboard(f.project.id,{requestId:randomUUID(),ids:[randomUUID()],paths:['/etc/passwd']}),e=>e.code==='INVALID_INPUT');
  assert.throws(()=>f.catalog.desktop.clipboard(f.project.id,{requestId:randomUUID(),ids:Array(51).fill(randomUUID())}),e=>e.code==='VIDEO_SELECTION_INVALID');
});

test('A: clipboard changes during hashing are not overwritten; unknown dispatch is never retried',async t=>{
  const f=await fixture(t),source=await imported(f),original=f.catalog.desktop.eligible.bind(f.catalog.desktop);
  f.catalog.desktop.eligible=async(...a)=>{const v=await original(...a);f.native.version++;return v;};
  const changed=await finish(f,f.catalog.desktop.clipboard(f.project.id,{requestId:randomUUID(),ids:[source.id]}));assert.equal(changed.code,'CLIPBOARD_CHANGED');assert.equal(changed.status,'failed');assert.equal(f.native.copies.length,0);
  f.catalog.desktop.eligible=original;f.native.copyFiles=async()=>{throw Object.assign(Error('lost native ACK'),{code:'NATIVE_PROTOCOL_ERROR',effectUnknown:true});};
  const input={requestId:randomUUID(),ids:[source.id]},unknown=await finish(f,f.catalog.desktop.clipboard(f.project.id,input));assert.equal(unknown.status,'unknown');
  f.native.copyFiles=()=>assert.fail('must not repeat');assert.deepEqual(f.catalog.desktop.clipboard(f.project.id,input),unknown);
});

test('A: clipboard version is frozen on admission, including time spent queued behind another desktop job',async t=>{
  const f=await fixture(t),source=await imported(f);let release;
  f.catalog.actionJournal.tail=new Promise(r=>{release=r;});
  const action=f.catalog.desktop.clipboard(f.project.id,{requestId:randomUUID(),ids:[source.id]});
  await new Promise(r=>setImmediate(r));f.native.version++;release();
  const result=await finish(f,action);
  assert.equal(result.code,'CLIPBOARD_CHANGED');assert.equal(result.status,'failed');assert.equal(f.native.copies.length,0);
});

test('B: preview has no Finder effect; explicit execution reports dispatched and distinct folders',async t=>{
  const f=await fixture(t),one=await imported(f),folder=await f.catalog.folders.create(f.project.id,{requestId:randomUUID(),parentId:'root',name:'合成子目录'}),two=await imported(f,undefined,folder.id);
  const preview=await finish(f,f.catalog.desktop.revealPreview(f.project.id,{requestId:randomUUID(),ids:[one.id,two.id]}));
  assert.equal(preview.status,'completed');assert.equal(preview.folderCount,2);assert.deepEqual(preview.folders.map(x=>x.count),[1,1]);assert.equal(f.native.reveals.length,0);
  const input={requestId:randomUUID(),ids:[one.id,two.id],previewToken:preview.previewToken},result=await finish(f,f.catalog.desktop.reveal(f.project.id,input));
  assert.equal(result.ack,'dispatched');assert.equal(result.count,2);assert.equal(f.native.reveals.length,1);assert.deepEqual(f.catalog.desktop.reveal(f.project.id,input),result);
});

test('B: stale folder/record/expired token cannot dispatch Finder',async t=>{
  const f=await fixture(t),source=await imported(f),preview=await finish(f,f.catalog.desktop.revealPreview(f.project.id,{requestId:randomUUID(),ids:[source.id]}));
  await f.catalog.update(f.project.id,source.id,{expectedRevision:1,title:'新标题',notes:'',prompt:{mode:'none'}});
  const result=await finish(f,f.catalog.desktop.reveal(f.project.id,{requestId:randomUUID(),ids:[source.id],previewToken:preview.previewToken}));
  assert.equal(result.code,'PREVIEW_STALE');assert.equal(f.native.reveals.length,0);
  const requestId=randomUUID();f.catalog.actionJournal.begin(f.project.id,'clipboard',{requestId,ids:[source.id]});
  assert.equal(f.catalog.actionJournal.dto(f.catalog.actionJournal.row(f.project.id,requestId)).status,'unknown');
});

test('shared stat recheck does not queue unrelated reads or trust a missing historic media baseline',async t=>{
  const f=await fixture(t),one=await imported(f),two=await imported(f),meta=f.catalog.metadata(f.project.id,one);
  f.catalog.record(f.project.id,one.id,{...meta.data,contentFingerprint:null},meta.row.revision);f.catalog.approveManaged(one);
  await appendXmp(one);await assert.rejects(f.catalog.verifiedSource(f.project.id,one.id),e=>e.code==='SOURCE_CHANGED');
  const original=f.catalog.hash.bind(f.catalog);let unblock;const blocked=new Promise(r=>{unblock=r;});
  f.catalog.hash=async(file,...args)=>{if(file===one.path)await blocked;return original(file,...args);};
  const pending=f.catalog.verifiedSource(f.project.id,one.id).catch(e=>e);await new Promise(r=>setTimeout(r,5));
  assert.equal((await f.catalog.verifiedSource(f.project.id,two.id)).id,two.id);unblock();await pending;
});


test('a queued video copy rechecks its authority after an image write has finished', async t=>{
  const f=await fixture(t),source=await imported(f);
  const native=new ProjectVideoDesktopNative({directory:f.dir});
  t.after(()=>native.close());
  native.helper=async()=>'/tmp/owned-stub';
  native.capabilities=async()=>({clipboard:{available:true}});
  f.catalog.desktop.native=native;
  const pic=f.dir+'/owned-photo.png',writes=[];
  let version=11, entered, release, queued;
  const firstWriting=new Promise(r=>{entered=r;}),holdAck=new Promise(r=>{release=r;}),enqueued=new Promise(r=>{queued=r;});
  native.invoke=async(_binary,req)=>{
    if(req.operation==='clipboard-version')return {changeCount:version};
    assert.equal(req.expectedChangeCount,version);
    writes.push(req.paths[0]);version++;
    if(req.paths[0]===pic){entered();await holdAck;}
    return {ack:'written',count:1,changeCount:version};
  };
  const copy=native.copyFiles.bind(native);
  native.copyFiles=(files,options)=>{
    const work=copy(files,options);
    if(files[0]===source.path)queued();
    return work;
  };
  const image=native.copyFiles([pic],{expectedChangeCount:11});
  await firstWriting;
  let receipt;
  try{
    const action=f.catalog.desktop.clipboard(f.project.id,{requestId:randomUUID(),ids:[source.id]});
    receipt=finish(f,action);
    await enqueued;
    await f.catalog.update(f.project.id,source.id,{expectedRevision:1,title:'Change while queued',notes:'',prompt:{mode:'none'}});
  }finally{release();}
  await image;
  const result=await receipt;
  assert.equal(result.status,'failed');assert.equal(result.code,'PREVIEW_STALE');
  assert.deepEqual(writes,[pic]);
});
