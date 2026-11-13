import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {randomUUID}from'node:crypto';import {Readable}from'node:stream';
import {Library}from'../server/library.mjs';import {Projects}from'../server/projects.mjs';import {ProjectAssets}from'../server/project-assets/store.mjs';import {CodexPictures}from'../server/prompt-codex/pictures.mjs';import {ReferenceImageImports,imageDigest}from'../server/project-assets/image-import.mjs';import {addLook,addImage}from'./helpers/creative-fixture.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=','base64');
async function fixture(t){const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'reference-import-unit-'))),lib=await new Library(path.join(dir,'data'),{directoryClassification:true}).init();lib.enqueue=()=>{};t.after(async()=>{lib.db.close();for(const s of imports.sessions.values())if(s.cache){assert.ok(path.basename(s.cache).startsWith('shiguang-reference-import-'));await fs.rm(s.cache,{recursive:true,force:true});}await fs.rm(dir,{recursive:true,force:true});});const projects=new Projects(lib).init(),store=new ProjectAssets(lib).init(),p=projects.save(null,{name:'合成项目'}),a=await store.create({project_id:p.id,kind:'character',name:'人物'});addLook(a);const pictures=new CodexPictures(lib,{directory:path.join(dir,'personal_item','picture')}),imports=new ReferenceImageImports(store,pictures);return{dir,lib,store,p,a,pictures,imports};}
function args(f,name='参考.png',size=png.length){return{requestId:randomUUID(),assetId:f.a.id,projectId:f.p.id,lookId:f.a.default_look_id,fileName:name,bytes:size};}
async function upload(f,name='参考.png',body=png){const start=await f.imports.start(args(f,name,body.length));return f.imports.upload(start.id,Readable.from([body]));}
test('单图复制和单文件登记不自动保存资料，手动保存两级默认，不同项目分目录',async t=>{const f=await fixture(t),r=await upload(f);assert.equal(r.status,'ready');assert.equal(f.store.get(f.a.id).images.length,0);assert.equal(f.store.get(f.a.id).revision,1);const row=f.lib.asset(r.mediaAssetId);assert.equal(row.kind,'photo');assert.deepEqual(await fs.readFile(row.path),png);assert.match(row.path,/personal_item\/picture\/合成项目--/);assert.equal(f.lib.jobs.size,0);addImage(f.a,r.mediaAssetId);const saved=await f.store.save(f.a.id,f.a,1);assert.equal(saved.looks[0].default_image_id,saved.images[0].id);const archived=structuredClone(saved);archived.images[0].archived_at=Date.now();archived.looks[0].default_image_id=null;await f.store.save(archived.id,archived,2);assert.deepEqual(await fs.readFile(row.path),png);assert.equal((await f.store.health(archived.id)).images[0].state,'available');});
test('同名及同内容不同名均提示，使用原图不复制；继续导入从_0递增且不覆盖',async t=>{const f=await fixture(t),first=await upload(f);const a=await upload(f,'另一名.png');assert.equal(a.status,'duplicate');assert.equal(a.candidates[0].reason,'相同内容');const reused=await f.imports.resolve(a.id,{choice:'reuse',candidateId:a.candidates[0].id});assert.equal(reused.mediaAssetId,first.mediaAssetId);const b=await upload(f);const copy=await f.imports.resolve(b.id,{choice:'import'});assert.equal(copy.fileName,'参考_0.png');const again=await f.imports.resolve(b.id,{choice:'import'});assert.equal(again.mediaAssetId,copy.mediaAssetId);const c=await upload(f);const next=await f.imports.resolve(c.id,{choice:'import'});assert.equal(next.fileName,'参考_1.png');assert.deepEqual(await fs.readFile(f.lib.asset(first.mediaAssetId).path),png);});
test('同名不同内容预览原图后继续导入，新图不改变旧代表图',async t=>{const f=await fixture(t),first=await upload(f);addImage(f.a,first.mediaAssetId);f.a=await f.store.save(f.a.id,f.a,1);const second=await upload(f,'参考.png',Buffer.concat([png,Buffer.from('different')]));assert.equal(second.status,'duplicate');assert.equal(second.candidates[0].reason,'同名图片');const r=await f.imports.resolve(second.id,{choice:'import'});const oldDefault=f.a.looks[0].default_image_id;addImage(f.a,r.mediaAssetId);const saved=await f.store.save(f.a.id,f.a,2);assert.equal(saved.looks[0].default_image_id,oldDefault);});
test('无扩展名或不支持格式不被拒绝，手动保存和全root扫描仍作为图片管理',async t=>{const f=await fixture(t),r=await upload(f,'合成设计.psd',Buffer.from('unsupported preview original'));addImage(f.a,r.mediaAssetId);const saved=await f.store.save(f.a.id,f.a,1);assert.equal((await f.store.health(saved.id)).images[0].state,'available');const job=f.lib.scan(f.lib.asset(r.mediaAssetId).root_id);while(job.status==='running')await new Promise(r=>setTimeout(r,10));assert.equal(job.status,'done');assert.equal(f.lib.asset(r.mediaAssetId).online,1);assert.equal(f.lib.asset(r.mediaAssetId).kind,'photo');});
test('超过旧100MB门的原文件流式导入、哈希与手动绑定',async t=>{const f=await fixture(t),size=101*1024*1024,chunk=Buffer.alloc(1024*1024,37),s=await f.imports.start(args(f,'大图.custom',size));async function* blocks(){for(let n=0;n<101;n++)yield chunk;}const r=await f.imports.upload(s.id,Readable.from(blocks()));assert.equal(f.lib.asset(r.mediaAssetId).size,size);assert.equal((await f.store.inspect(r.mediaAssetId,null,true)).state,'available');});
test('失败传输、重复request、目标归档及项目替换不伪称成功',async t=>{const f=await fixture(t),input=args(f),s=await f.imports.start(input);assert.equal((await f.imports.start(input)).id,s.id);await assert.rejects(f.imports.start({...input,fileName:'不同.png'}),/其他文件/);await assert.rejects(f.imports.upload(s.id,Readable.from([png.subarray(0,9)])),/没有完整/);assert.equal(f.imports.dto(f.imports.get(s.id)).status,'failed');assert.equal(f.lib.db.prepare('SELECT COUNT(*) n FROM assets').get().n,0);const waiting=await f.imports.start(args(f));f.store.archive(f.a.id,true,1);await assert.rejects(f.imports.upload(waiting.id,Readable.from([png])),/归档/);});
test('候选内容变化及文件链接拒绝，不覆盖原图',async t=>{const f=await fixture(t),r=await upload(f),dup=await upload(f);const file=f.lib.asset(r.mediaAssetId).path;await fs.writeFile(file,'changed');await assert.rejects(f.imports.resolve(dup.id,{choice:'reuse',candidateId:dup.candidates[0].id}),/变化/);await fs.unlink(file);await fs.symlink(path.join(f.dir,'missing'),file);await assert.rejects(imageDigest(file),/变化/);});
test('新造型、场景/道具与公共人物导入不提前创建绑定',async t=>{const f=await fixture(t);for(const kind of['scene','prop']){const a=await f.store.create({project_id:f.p.id,kind,name:kind}),s=await f.imports.start({requestId:randomUUID(),assetId:a.id,projectId:f.p.id,lookId:null,fileName:kind+'.png',bytes:png.length});const result=await f.imports.upload(s.id,Readable.from([Buffer.from(png)]));const r=result.status==='duplicate'?await f.imports.resolve(s.id,{choice:'import'}):result;addImage(a,r.mediaAssetId);const saved=await f.store.save(a.id,a,1);assert.equal(saved.default_image_id,saved.images[0].id);}const pub=f.store.scopes().items.find(p=>p.project_kind==='public');f.p=pub;f.a=await f.store.create({project_id:pub.id,kind:'character',name:'公共人物'});addLook(f.a);const r=await upload(f);assert.match(f.lib.asset(r.mediaAssetId).path,/公共人物库--/);assert.equal(f.store.get(f.a.id).looks.length,0);});
test('并发重复request编号在首次await前固定目标，不得被另一个项目替换',async t=>{const f=await fixture(t),input=args(f),prepare=f.pictures.prepare.bind(f.pictures);let release,entered;const ready=new Promise(r=>entered=r),wait=new Promise(r=>release=r);f.pictures.prepare=async()=>{entered();await wait;return prepare();};const first=f.imports.start(input);await ready;await assert.rejects(f.imports.start({...input,lookId:null,fileName:'other.png'}),/其他文件/);release();const s=await first;assert.deepEqual(s.target,{assetId:input.assetId,projectId:input.projectId,lookId:input.lookId});const r=await f.imports.upload(s.id,Readable.from([png]));assert.equal(r.target.lookId,input.lookId);});
test('取消仅结束请求并保留暂存，已完成原图和关联均不改写',async t=>{const f=await fixture(t),r=await upload(f),d=await upload(f);const stage=f.imports.get(d.id).stage;const cancelled=await f.imports.cancel(d.id);assert.equal(cancelled.status,'cancelled');assert.ok((await fs.stat(stage)).isFile());assert.deepEqual(await fs.readFile(f.lib.asset(r.mediaAssetId).path),png);assert.equal((await f.imports.cancel(r.id)).status,'ready');assert.deepEqual(await fs.readFile(f.lib.asset(r.mediaAssetId).path),png);});
test('校验后原图改变，返回的预览仍是已校验快照',async t=>{const f=await fixture(t),r=await upload(f),file=f.lib.asset(r.mediaAssetId).path;const {Writable}=await import('node:stream'),{writeFileSync}=await import('node:fs'),{streamImage}=await import('../server/project-assets/image-import.mjs');const chunks=[],response=new Writable({write(c,_e,next){chunks.push(Buffer.from(c));next();}});response.set=()=>writeFileSync(file,Buffer.alloc(png.length,3));await streamImage(file,(await imageDigest(file)).hash,response);assert.deepEqual(Buffer.concat(chunks),png);assert.notDeepEqual(await fs.readFile(file),png);});
test('发布子进程启动时原目录换链，不向替换目录发布原图正文',async t=>{const f=await fixture(t),input=args(f),s=await f.imports.start(input),cp=await import('node:child_process'),module=await import('node:module'),sync=await import('node:fs');const original=cp.default.spawn,outside=path.join(f.dir,'outside');await fs.mkdir(outside);let swapped=false;cp.default.spawn=function(...args){if(String(args[1]?.[0]||'').endsWith('image-publish-worker.mjs')&&!swapped){swapped=true;const target=f.imports.get(s.id).state.target;sync.renameSync(target,target+'-held');sync.symlinkSync(outside,target);}return original.apply(this,args);};module.syncBuiltinESMExports();try{await assert.rejects(f.imports.upload(s.id,Readable.from([png])),/变化|正常完成/);assert.equal(swapped,true);assert.deepEqual(await fs.readdir(outside),[]);}finally{cp.default.spawn=original;module.syncBuiltinESMExports();}});

test('集内上传共享图片进入剧目录，仍需另行确认绑定，换季后的旧确认不能继续', async t => {
  const f = await fixture(t), series = f.lib.projectSeries;
  const drama = series.createSeries({name:'合成图片全剧', request_id:randomUUID()});
  const season = series.createSeason(drama.id, {request_id:randomUUID()});
  const episode = series.createEpisode(drama.id, {season_id:null, expected_episode_no:1, request_id:randomUUID()}).project;
  const context = f.store.scoped.list('series', drama.id).context_token;
  const scope = f.store.scoped.assetContext(episode.id);
  const {asset} = f.store.scopedWrites.create('series', drama.id, {
    kind:'character', name:'合成共享人物', on_shared:'reject', request_id:randomUUID(), context_token:context,
  });
  const look = addLook(asset);
  await f.store.scopedWrites.save('series', drama.id, asset.id, {
    request_id:randomUUID(), context_token:context, expected_revision:asset.revision, asset,
  });
  const start = {
    requestId:randomUUID(), assetId:asset.id, projectId:episode.id, lookId:look.id,
    fileName:'共享参考.png', bytes:png.length, append_context_token:scope.context_token,
  };
  await assert.rejects(f.imports.start({...start, append_context_token:context}), {code:'ASSET_SCOPE_CHANGED'});
  const selected = await f.imports.start(start);
  const ready = await f.imports.upload(selected.id, Readable.from([png]));
  assert.equal(ready.status, 'ready');
  assert.equal(f.store.get(asset.id).images.length, 0);
  assert.equal(path.basename(path.dirname(f.lib.asset(ready.mediaAssetId).path)), '合成图片全剧--'+drama.id);
  assert.equal(f.imports.dto(f.imports.get(selected.id)).mediaAssetId, ready.mediaAssetId);
  const waiting = await f.imports.start({...start, requestId:randomUUID(), fileName:'另一张.png'});
  series.move({request_id:randomUUID(), target:{series_id:drama.id,season_id:season.id},
    items:[{project_id:episode.id,expected_revision:scope.membership_revision,episode_no:1}]});
  await assert.rejects(f.imports.upload(waiting.id, Readable.from([png])), {code:'ASSET_SCOPE_CHANGED'});
});

test('全剧本地参考图使用剧 ID 和令牌，登记后通过全剧保存绑定', async t => {
  const f = await fixture(t);
  const directory = f.lib.projectSeries;
  const series = directory.createSeries({ request_id: randomUUID(), name: '合成全剧' });
  const episode = directory.createEpisode(series.id, {
    request_id: randomUUID(), season_id: null, expected_episode_no: 1,
  }).project;
  const context = f.store.scoped.list('series', series.id).context_token;
  const { asset } = f.store.scopedWrites.create('series', series.id, {
    request_id: randomUUID(), context_token: context, kind: 'scene', name: '共享场景', on_shared: 'reject',
  });
  const input = {
    requestId: randomUUID(), assetId: asset.id, projectId: series.id, lookId: null,
    fileName: '全剧参考.png', bytes: png.length, series_context_token: context,
  };
  await assert.rejects(f.imports.start({
    ...input, series_context_token: f.store.scoped.assetContext(episode.id).context_token,
  }), { code: 'ASSET_SCOPE_CHANGED' });
  const session = await f.imports.start(input);
  const uploaded = await f.imports.upload(session.id, Readable.from([png]));
  assert.equal(uploaded.status, 'ready');
  assert.equal(f.imports.dto(f.imports.get(input.requestId)).mediaAssetId, uploaded.mediaAssetId);
  const media = f.lib.asset(uploaded.mediaAssetId);
  assert.equal(path.basename(path.dirname(media.path)), series.name + '--' + series.id);
  assert.deepEqual(await fs.readFile(media.path), png);
  assert.equal(f.store.scoped.detail('series', series.id, asset.id).asset.images.length, 0);
  addImage(asset, uploaded.mediaAssetId);
  const saved = await f.store.scopedWrites.save('series', series.id, asset.id, {
    request_id: randomUUID(), context_token: context, expected_revision: asset.revision, asset,
  });
  const inherited = f.store.scoped.detail('episode', episode.id, asset.id);
  assert.equal(inherited.asset.images[0].id, saved.asset.images[0].id);
  assert.equal(inherited.effective.default_images.null.value, saved.asset.images[0].id);
});
