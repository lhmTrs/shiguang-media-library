import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {creativeFixture,addLook,addImage} from './helpers/creative-fixture.mjs';
import {ProjectAssetDesktopActions} from '../server/project-assets/desktop-actions.mjs';

const cap={clipboard:{available:true},revealMany:{available:true}};
const items=(...bindings)=>bindings.map(b=>({bindingId:b.id,bindingRevision:b.revision}));
const request=(mode,...bindings)=>({requestId:randomUUID(),mode,items:items(...bindings)});
async function setup(t){
  const f=await creativeFixture(),calls=[];
  const native={
    capabilities:async()=>cap,
    clipboardVersion:async()=>19,
    copyFiles:async(paths,{beforeDispatch,...options})=>{await beforeDispatch?.();calls.push(['copy',paths,options]);return {ack:'written',count:paths.length};},
    revealFiles:async (paths,{beforeDispatch}={})=>{await beforeDispatch?.();calls.push(['reveal',paths]);return {ack:'dispatched',count:paths.length};},
  };
  const actions=new ProjectAssetDesktopActions(f.store,native);
  t.after(async()=>{await actions.close();await f.close();});
  const person=async(projectId,name)=>{
    const a=await f.store.create({project_id:projectId,kind:'character',name});
    addLook(a);addImage(a,f.media);
    return f.store.save(a.id,a,a.revision);
  };
  const finish=async(input,projectId=f.a.id)=>{
    for(let n=0;n<200;n++){
      const result=actions.status(projectId,input.requestId);
      if(!['checking','dispatching'].includes(result.status))return result;
      await delay(5);
    }
    assert.fail('no terminal receipt');
  };
  return {...f,calls,native,actions,person,finish};
}

test('only current default bindings in the requested project reach the file clipboard, and retries return the original result',async t=>{
  const f=await setup(t),a=await f.person(f.a.id,'甲'),b=await f.person(f.b.id,'乙');
  addImage(a,f.media);
  const current=await f.store.save(a.id,a,a.revision);
  const input=request('defaults',current.images[0],b.images[0],current.images[1]);
  assert.deepEqual(await f.actions.capabilities(f.a.id),{version:1,maxSelection:50,...cap});
  assert.equal(f.actions.clipboard(f.a.id,input).status,'checking');
  const result=await f.finish(input);
  assert.equal(result.status,'partial');
  assert.deepEqual(result.copied,[{bindingId:current.images[0].id,name:'synthetic.png'}]);
  assert.deepEqual(result.skipped.map(s=>[s.bindingId,s.code]),[[b.images[0].id,'IMAGE_BINDING_STALE'],[current.images[1].id,'IMAGE_BINDING_STALE']]);
  assert.deepEqual(f.calls,[['copy',[f.image],{expectedChangeCount:19}]]);
  assert.deepEqual(f.actions.clipboard(f.a.id,input),result);
  assert.throws(()=>f.actions.clipboard(f.a.id,{...input,mode:'references'}),{code:'REQUEST_ID_CONFLICT'});
  assert.equal(f.calls.length,1);
});

test('reference photos can span looks, preserve original filenames, and reveal verifies original selection and file identity',async t=>{
  const f=await setup(t);
  let a=await f.person(f.a.id,'多个造型');
  const dir=path.join(f.dir,'第二个目录'),image=path.join(dir,'原图.HEIC'),mediaId=randomUUID();
  await fs.mkdir(dir);await fs.writeFile(image,'original HEIC fixture bytes');
  f.db.prepare('INSERT INTO assets VALUES(?,?,?,?,?,0)').run(mediaId,f.root,image,'目录中的原图','photo');
  const second=addLook(a,'另外一套');addImage(a,mediaId,second.id);addImage(a,mediaId,second.id);
  a=await f.store.save(a.id,a,a.revision);
  const input=request('references',...a.images);
  f.actions.revealPreview(f.a.id,input);
  const preview=await f.finish(input);
  assert.equal(preview.status,'partial');assert.equal(preview.folderCount,2);
  assert.equal(preview.skipped[0].code,'DUPLICATE_FILE_IN_SELECTION');
  assert.equal(preview.eligible[1].name,'原图.HEIC');
  assert.ok(!JSON.stringify(preview).includes(f.dir));
  const confirm={...input,requestId:randomUUID(),previewToken:preview.previewToken};
  f.actions.reveal(f.a.id,confirm);
  assert.equal((await f.finish(confirm)).status,'partial');
  assert.deepEqual(f.calls,[['reveal',[f.image,image]]]);
  const wrong={...confirm,requestId:randomUUID(),items:items(a.images[0])};
  f.actions.reveal(f.a.id,wrong);assert.equal((await f.finish(wrong)).code,'PREVIEW_STALE');
  await fs.writeFile(image,'changed after confirmation');
  const stale={...confirm,requestId:randomUUID()};
  f.actions.reveal(f.a.id,stale);assert.equal((await f.finish(stale)).code,'PREVIEW_STALE');
  assert.equal(f.calls.length,1);
});

test('known clipboard conflict and lost acknowledgement are different terminal receipts and never replay',async t=>{
  const f=await setup(t),a=await f.person(f.a.id,'甲');
  let attempts=0;
  f.native.copyFiles=async()=>{attempts++;throw Object.assign(Error('native fixture'),attempts===1?{code:'CLIPBOARD_CHANGED',effectUnknown:false}:{code:'NATIVE_TIMEOUT',effectUnknown:true});};
  const one=request('defaults',a.images[0]),two=request('defaults',a.images[0]);
  f.actions.clipboard(f.a.id,one);f.actions.clipboard(f.a.id,two);
  const known=await f.finish(one),unknown=await f.finish(two);
  assert.equal(known.status,'failed');assert.equal(known.code,'CLIPBOARD_CHANGED');
  assert.equal(unknown.status,'unknown');assert.equal(unknown.code,'NATIVE_TIMEOUT');
  assert.deepEqual(f.actions.clipboard(f.a.id,two),unknown);
  assert.equal(attempts,2);
});

test('a registration change during the final Finder check cannot dispatch the old still-present file',async t=>{
  const f=await setup(t),a=await f.person(f.a.id,'旧路径');
  const input=request('defaults',a.images[0]);
  f.actions.revealPreview(f.a.id,input);
  const preview=await f.finish(input),other=path.join(f.dir,'new-file.png');
  await fs.copyFile(f.image,other);
  const checked=f.lib.checked;
  f.lib.checked=async(p,id)=>{
    const file=await checked(p,id);
    f.db.prepare('UPDATE assets SET path=? WHERE id=?').run(other,f.media);
    return file;
  };
  const confirm={...input,requestId:randomUUID(),previewToken:preview.previewToken};
  f.actions.reveal(f.a.id,confirm);
  const result=await f.finish(confirm);
  assert.equal(result.status,'failed');assert.equal(result.code,'PREVIEW_STALE');
  assert.deepEqual(f.calls,[]);
});
