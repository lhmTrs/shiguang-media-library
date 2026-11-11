import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {creativeFixture,addLook,addImage} from './helpers/creative-fixture.mjs';
import {pickHeadBox,ProjectAssetHeadBox} from '../server/project-assets/head-box.mjs';

const FACE={x:.11,y:.16,w:.15,h:.22,confidence:.99,yaw:.12};
const FOUND={status:'decoded',width:1200,height:800,faces:[FACE]};
const DEFAULT={x:50,y:50,zoom:1};

async function setup(t){
  const f=await creativeFixture(),calls=[];
  const native={detectFace:async file=>{calls.push(file);assert.notEqual(file,f.image);assert.deepEqual(await fs.readFile(file),await fs.readFile(f.image));return FOUND;}};
  const headBox=new ProjectAssetHeadBox(f.store,native,{enabled:true});
  t.after(async()=>{await headBox.close();await f.close();});
  const a=await f.store.create({project_id:f.a.id,kind:'character',name:'测试人物'});const look=addLook(a);
  for(let i=0;i<4;i++)addImage(a,f.media);
  return {...f,calls,native,headBox,lookId:look.id,a:await f.store.save(a.id,a,a.revision)};
}

test('crop uses the portrait card geometry, prefers an observed frontal face and declines ambiguous multi-face images',()=>{
  const profile={x:.5,y:.2,w:.31,h:.36,confidence:.99,yaw:1},other={...FACE,x:.65};
  assert.deepEqual(pickHeadBox(1200,800,[FACE,other]),{status:'not_found'});
  assert.deepEqual(pickHeadBox(1200,800,[]),{status:'not_found'});
  const result=pickHeadBox(1200,800,[FACE,profile]);
  assert.equal(result.status,'found');assert.equal(result.face.x,FACE.x);
  const {x,y,zoom}=result.crop,w=600/zoom,h=w/.75,l=(1200-w)*x/100,top=(800-h)*y/100;
  assert.ok(l<=FACE.x*1200&&l+w>=(FACE.x+FACE.w)*1200&&top<=FACE.y*800&&top+h>=(FACE.y+FACE.h)*800);
  assert.equal(pickHeadBox(1200,800,[{...FACE,yaw:undefined},{...other,yaw:undefined}]).status,'not_found');
});

test('read-only suggestions are versioned, delete the snapshot, and recheck bytes even on cache hits',async t=>{
  const f=await setup(t),b=f.a.images[0],before=f.store.backup().checksum;
  const result=await f.headBox.get(b.id,String(b.revision));
  assert.equal(result.status,'found');assert.equal(result.bindingRevision,b.revision);
  assert.equal(f.store.backup().checksum,before);
  await assert.rejects(fs.stat(f.calls[0]),{code:'ENOENT'});
  assert.deepEqual(await f.headBox.get(b.id),result);assert.equal(f.calls.length,1);
  await fs.writeFile(f.image,'replacement bytes');
  await assert.rejects(f.headBox.get(b.id),{code:'IMAGE_BINDING_STALE',status:409});
});

test('first card adoption applies in the same asset version; undo and revisiting do not detect again',async t=>{
  const f=await setup(t);let a=f.a;f.store.headBox=f.headBox;
  const original=a.images[0],next=a.images[1];a.looks[0].default_image_id=next.id;
  const start=a.revision;
  a=await f.store.save(a.id,a,start);
  assert.equal(a.revision,start+1);assert.equal(a.looks[0].default_image_id,next.id);
  assert.equal(a.images[1].crop_source,'auto');assert.equal(a.images[1].was_card_default,true);
  assert.notDeepEqual(a.images[1].crop,DEFAULT);
  assert.equal(f.calls.length,1);
  a.looks[0].default_image_id=original.id;Object.assign(a.images[1],{crop:DEFAULT,crop_source:'untouched',was_card_default:false});
  a=await f.store.save(a.id,a,a.revision);
  assert.equal(a.images[1].was_card_default,true);assert.equal(a.images[1].crop_source,'untouched');
  a.looks[0].default_image_id=next.id;a=await f.store.save(a.id,a,a.revision);
  assert.deepEqual(a.images[1].crop,DEFAULT);assert.equal(f.calls.length,1);
});

test('manual editing at default values and legacy records remain protected on first adoption',async t=>{
  const f=await setup(t);let a=f.a;f.store.headBox=f.headBox;
  const legacyId=a.images[2].id;
  const data=f.db.prepare('SELECT data_json FROM creative_image_bindings WHERE id=?').get(legacyId);
  const old=JSON.parse(data.data_json);delete old.crop_source;delete old.crop_manually_edited;delete old.was_card_default;
  f.db.prepare('UPDATE creative_image_bindings SET data_json=? WHERE id=?').run(JSON.stringify(old),legacyId);
  a=f.store.get(a.id);assert.equal(a.images[2].crop_source,null);
  a.images[1].crop_source='manual';a=await f.store.save(a.id,a,a.revision);
  assert.deepEqual(a.images[1].crop,DEFAULT);assert.equal(a.images[1].crop_manually_edited,true);
  for(const id of [a.images[1].id,legacyId]){
    a.looks[0].default_image_id=id;a=await f.store.save(a.id,a,a.revision);
  }
  assert.equal(f.calls.length,0);
  assert.equal(a.images[2].crop_source,null);
  const suggestion=await f.headBox.get(legacyId);
  a.images[2].crop=suggestion.crop;a.images[2].crop_source='auto';
  a=await f.store.save(a.id,a,a.revision);
  assert.equal(a.images[2].crop_source,'auto');assert.equal(a.images[1].crop_manually_edited,true);
});

test('late detector response cannot apply to an updated binding or overwrite a concurrent asset save',async t=>{
  const f=await setup(t);
  let release,entered;
  let started=new Promise(r=>{entered=r;});let outcome=new Promise(r=>{release=r;});
  f.native.detectFace=async()=>{entered();return outcome;};
  let a=f.a;
  const response=f.headBox.get(a.images[0].id);
  await started;
  a.images[0].purpose='另一窗口修改';a=await f.store.save(a.id,a,a.revision);
  release(FOUND);await assert.rejects(response,{code:'IMAGE_BINDING_STALE'});
  f.headBox.cache.clear();f.store.headBox=f.headBox;
  started=new Promise(r=>{entered=r;});outcome=new Promise(r=>{release=r;});
  const copy=structuredClone(a);copy.looks[0].default_image_id=copy.images[1].id;
  const save=f.store.save(copy.id,copy,copy.revision);
  await started;
  a.name='另一窗口的新名字';a=await f.store.save(a.id,a,a.revision);
  release(FOUND);await assert.rejects(save,{status:409});
  assert.equal(f.store.get(a.id).name,a.name);assert.equal(f.store.get(a.id).looks[0].default_image_id,a.images[0].id);
});

test('unavailable helper does not block selecting a default or regular manual editing',async t=>{
  const f=await setup(t);let a=f.a;f.store.headBox=f.headBox;
  f.native.detectFace=async()=>{throw Object.assign(Error('fixture timeout'),{code:'NATIVE_TIMEOUT'});};
  a.looks[0].default_image_id=a.images[1].id;
  a=await f.store.save(a.id,a,a.revision);
  assert.equal(a.images[1].crop_source,'untouched');
  a.images[1].crop={x:30,y:20,zoom:1.2};a.images[1].crop_source='manual';
  a=await f.store.save(a.id,a,a.revision);
  assert.equal(a.images[1].crop_manually_edited,true);
});

test('a native HEIC conversion feeds the detector JPEG in the browser preview orientation and keeps the original', {skip:process.platform!=='darwin'}, async t=>{
  const f=await setup(t),ppm=path.join(f.dir,'synthetic.ppm'),file=path.join(f.dir,'synthetic.HEIC');
  await fs.writeFile(ppm,Buffer.concat([Buffer.from('P6\n96 64\n255\n'),Buffer.alloc(96*64*3,120)]));
  await promisify(execFile)('/usr/bin/sips',['-s','format','heic',ppm,'--out',file]);
  const original=await fs.readFile(file);
  f.db.prepare('UPDATE assets SET path=? WHERE id=?').run(file,f.media);
  const a=f.store.get(f.a.id);a.images[0].accept_current=true;
  const saved=await f.store.save(a.id,a,a.revision);
  let snapshot;
  f.native.detectFace=async value=>{
    snapshot=value;
    const data=await fs.readFile(value);
    assert.deepEqual([...data.subarray(0,3)],[255,216,255]);
    return {status:'decoded',width:96,height:64,faces:[]};
  };
  assert.equal((await f.headBox.get(saved.images[0].id)).status,'not_found');
  assert.deepEqual(await fs.readFile(file),original);
  await assert.rejects(fs.stat(snapshot),{code:'ENOENT'});
});
