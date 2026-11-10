import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import express from 'express';
import {createHash} from 'node:crypto';
import {Receipts} from '../server/file-intake/files.mjs';
import {fileIntakeRouter} from '../server/file-intake/router.mjs';
import {VideoMedia} from '../server/storyboard-video/media.mjs';
import {imagePreviewCache,ImagePreviewCache,convertHeic,previewSourceLimit} from '../server/project-assets/image-preview.mjs';
const run=promisify(execFile),native={skip:process.platform!=='darwin'};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const jpeg=Buffer.from([255,216,255,224,0,2,255,217]);
async function until(fn){const end=Date.now()+4000;while(!fn()){if(Date.now()>end)throw Error('bounded wait exceeded');await new Promise(r=>setTimeout(r,5));}}
async function fixture(t,{valid=true,ext='HEIC'}={}) {
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-heic-test-')));
  const file=path.join(dir,'owned.'+ext),ppm=path.join(dir,'owned.ppm');
  const pixels=Buffer.alloc(96*64*3);for(let i=0;i<pixels.length;i+=3){pixels[i]=30;pixels[i+1]=150;pixels[i+2]=80;}
  await fs.writeFile(ppm,Buffer.concat([Buffer.from('P6\n96 64\n255\n'),pixels]));
  if(valid)await run('/usr/bin/sips',['-s','format',ext.toLowerCase()==='png'?'png':'heic',ppm,'--out',file]);else await fs.writeFile(file,'not an image');
  const receipts=await new Receipts(path.join(dir,'data')).init(),media=new VideoMedia();
  const handoff=await receipts.handoff([file]);let active=0;
  const app=express();app.use('/api/file-intake',fileIntakeRouter({receipts,catalog:{media}},{},{withActivity:async fn=>{active++;try{return await fn();}finally{active--;}}}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const url='http://127.0.0.1:'+server.address().port+'/api/file-intake/handoffs/'+handoff.id+'/files/'+handoff.files[0].id+'/preview';
  const temps=[],mkdtemp=fs.mkdtemp;
  t.mock.method(fs,'mkdtemp',async(...args)=>{const value=await mkdtemp(...args);if(String(args[0]).includes('shiguang-reference-preview-'))temps.push(await fs.realpath(value));return value;});
  t.after(async()=>{
    await media.close();await new Promise(resolve=>server.close(resolve));
    assert.equal(active,0);assert.equal(media.work.size,0);assert.equal(media.responses.size,0);assert.equal(media.children.size,0);assert.equal(media.exits.size,0);assert.equal(media.handles.size,0);assert.equal(imagePreviewCache.active,0);
    for(const temp of temps)await assert.rejects(fs.access(temp),{code:'ENOENT'});
    await fs.rm(dir,{recursive:true,force:true});
  });
  return {dir,file,receipts,media,handoff,url};
}

test('native HEIC and HEIF deliver real JPEG from verified bytes; repeat uses cache',native,async t=>{
  for(const ext of ['HEIC','heif']){
    const f=await fixture(t,{ext}),before=await fs.readFile(f.file),runner=imagePreviewCache.runner;let calls=0;
    const mocked=t.mock.method(imagePreviewCache,'runner',async(...args)=>{calls++;return runner(...args);});
    for(let i=0;i<2;i++){
      const r=await fetch(f.url);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/^image\/jpeg/);
      assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('x-content-type-options'),'nosniff');
      const bytes=Buffer.from(await r.arrayBuffer());assert.equal(Number(r.headers.get('content-length')),bytes.length);assert.equal(bytes.subarray(0,3).toString('hex'),'ffd8ff');
      const output=path.join(f.dir,'delivered.jpg');await fs.writeFile(output,bytes);
      const dimensions=await run('/usr/bin/sips',['-g','pixelWidth','-g','pixelHeight',output]);assert.match(dimensions.stdout,/pixelWidth: 1200/);assert.match(dimensions.stdout,/pixelHeight: 800/);
    }
    assert.equal(calls,1);assert.equal(hash(await fs.readFile(f.file)),hash(before));mocked.mock.restore();
  }
});

test('corrupt HEIC fails visibly with JSON, original retained, not cached',native,async t=>{
  const f=await fixture(t,{valid:false});const r=await fetch(f.url);assert.equal(r.status,503);const result=await r.json();assert.match(result.code,/IMAGE_PREVIEW/);assert.match(result.error,/原文件仍保留/);assert.equal(await fs.readFile(f.file,'utf8'),'not an image');
});

test('PNG keeps original bytes and MIME; selected generation, content and links cannot use a cached HEIC',native,async t=>{
  const png=await fixture(t,{ext:'png'}),r=await fetch(png.url);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/^image\/png/);assert.deepEqual(Buffer.from(await r.arrayBuffer()),await fs.readFile(png.file));
  const f=await fixture(t);assert.equal((await fetch(f.url)).status,200);
  const original=await fs.readFile(f.file),st=await fs.stat(f.file);await fs.rename(f.file,f.file+'.kept');await fs.writeFile(f.file,original);await fs.utimes(f.file,st.atime,st.mtime);
  assert.equal((await fetch(f.url)).status,409,'same bytes at a new inode must not reuse the old receipt');
  await fs.unlink(f.file);await fs.symlink(f.file+'.kept',f.file);assert.equal((await fetch(f.url)).status,409);
});

test('content changes after cache fill and source changes during conversion are rejected',native,async t=>{
  const f=await fixture(t);assert.equal((await fetch(f.url)).status,200);await fs.appendFile(f.file,'changed');assert.equal((await fetch(f.url)).status,409);
  const g=await fixture(t),runner=imagePreviewCache.runner;
  t.mock.method(imagePreviewCache,'runner',async(...args)=>{await runner(...args);await fs.appendFile(g.file,'changed while converting');});
  const r=await fetch(g.url);assert.equal(r.status,409);assert.match((await r.json()).error,/变化|变更/);
});

test('parent generation change rejects a prepared selection',native,async t=>{
  const f=await fixture(t),parent=path.dirname(f.file),kept=parent+'-kept';
  // Move only the source into a newly owned parent and bind a fresh handoff there.
  const sourceDir=path.join(parent,'source');await fs.mkdir(sourceDir);const source=path.join(sourceDir,'image.heic');await fs.copyFile(f.file,source);
  const h=await f.receipts.handoff([source]);await fs.rename(sourceDir,kept);await fs.mkdir(sourceDir);await fs.copyFile(path.join(kept,'image.heic'),source);
  t.after(()=>fs.rm(kept,{recursive:true,force:true}));
  assert.equal((await fetch(f.url.replace(f.handoff.id,h.id).replace(f.handoff.files[0].id,h.files[0].id))).status,409);
});

test('two in-flight requests admitted, excess rejected without queue; client abort settles resources',native,async t=>{
  const f=await fixture(t);let started=0,aborted=0;
  t.mock.method(imagePreviewCache,'runner',async(_input,_output,{signal})=>{
    started++;await new Promise((resolve,reject)=>{const abort=()=>{aborted++;reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
  });
  const a=new AbortController(),b=new AbortController();
  const first=fetch(f.url,{signal:a.signal}).catch(e=>e),second=fetch(f.url,{signal:b.signal}).catch(e=>e);
  await until(()=>started===2);const extra=await fetch(f.url);assert.equal(extra.status,429);assert.equal((await extra.json()).code,'IMAGE_PREVIEW_BUSY');
  a.abort();b.abort();await Promise.all([first,second]);await until(()=>f.media.work.size===0);
  assert.equal(aborted,2);assert.equal(f.media.responses.size,0);
});

test('normal module close aborts response and native conversion; all work is settled',native,async t=>{
  const f=await fixture(t);const request=fetch(f.url).then(r=>r.arrayBuffer()).catch(e=>e);
  await until(()=>f.media.children.size===1);
  await f.media.close();await request;
  assert.equal(f.media.children.size,0);assert.equal(f.media.exits.size,0);assert.equal(f.media.work.size,0);
});

test('client cancellation during snapshot copying releases the original descriptor and private files',native,async t=>{
  const f=await fixture(t),controller=new AbortController(),open=fs.open;let cancelled=false,closed=false;
  t.mock.method(fs,'open',async(file,...args)=>{
    const handle=await open(file,...args);
    if(file===f.file){
      const readStream=handle.createReadStream.bind(handle),close=handle.close.bind(handle);
      handle.close=async()=>{try{return await close();}finally{closed=true;}};
      handle.createReadStream=(...options)=>{
        const stream=readStream(...options),emit=stream.emit;
        stream.emit=function(event,...values){if(event==='data'&&!cancelled){cancelled=true;controller.abort();}return emit.call(this,event,...values);};
        return stream;
      };
    }
    return handle;
  });
  await fetch(f.url,{signal:controller.signal}).catch(()=>{});await until(()=>f.media.work.size===0);
  assert.equal(cancelled,true);assert.equal(closed,true);
});

test('oversized source is rejected before snapshot or converter work',native,async t=>{
  const f=await fixture(t);await fs.truncate(f.file,previewSourceLimit+1);const h=await f.receipts.handoff([f.file]);
  const r=await fetch(f.url.replace(f.handoff.id,h.id).replace(f.handoff.files[0].id,h.files[0].id));assert.equal(r.status,413);assert.match((await r.json()).error,/过大/);
});

test('bounded cache evicts by count, bytes and expiry; failed or invalid outputs are not cached',async t=>{
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-preview-cache-'))),output=path.join(dir,'output.jpg');t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let calls=0;const cache=new ImagePreviewCache({maxEntries:2,maxBytes:jpeg.length*2,runner:async()=>{calls++;await fs.writeFile(output,jpeg);}});
  const context={signal:new AbortController().signal};
  for(const key of ['a','b','c'])await cache.preview('',output,key,context);
  assert.equal(cache.entries.size,2);assert.equal(cache.entries.has('a'),false);assert.equal(cache.bytes,jpeg.length*2);
  await cache.preview('',output,'c',context);assert.equal(calls,3);
  for(const v of cache.entries.values())v.expires=0;
  await cache.preview('',output,'d',context);assert.equal(cache.entries.size,1);
  cache.runner=async()=>{throw Error('owned tool failure');};await assert.rejects(cache.preview('',output,'failed',context),/owned tool failure/);assert.equal(cache.entries.has('failed'),false);
  cache.runner=async()=>fs.writeFile(output,'not JPEG');await assert.rejects(cache.preview('',output,'invalid',context),e=>e.code==='IMAGE_PREVIEW_FAILED');assert.equal(cache.entries.has('invalid'),false);
  cache.runner=async()=>{await fs.unlink(output);await fs.symlink('other',output);};await assert.rejects(cache.preview('',output,'link',context),e=>e.code==='IMAGE_PREVIEW_FAILED');
});

test('native converter close is tracked through child close, never a forced signal',native,async t=>{
  const f=await fixture(t),output=path.join(f.dir,'close.jpg');const work=f.media.track(()=>convertHeic(f.file,output,{media:f.media}));
  const result=work.catch(e=>e);await until(()=>f.media.children.size===1);await f.media.close();await result;assert.equal(f.media.children.size,0);assert.equal(f.media.exits.size,0);
});
