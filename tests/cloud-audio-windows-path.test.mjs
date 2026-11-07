import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isCloudAudioRootPath } from '../server/cloud-audio-path.mjs';
import { CloudAudioJobStore } from '../server/cloud-audio-store.mjs';

const input = rootPath => ({ audioId:crypto.randomUUID(),shareId:crypto.randomUUID(),accountId:'synthetic-owner',deviceId:'synthetic-device',originHost:'synthetic.invalid',epoch:1,rootId:'synthetic-root',rootName:'合成根',rootPath,rootGeneration:'a'.repeat(64),category:'系统验证',subcategory:'私有合成',fileName:'synthetic.wav',mediaKind:'MUSIC',bytes:11068,sha256:'b'.repeat(64),mimeType:'audio/wav' });
async function directory(t) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-w02-path-')));
  await fs.chmod(root,0o700);
  t.diagnostic(JSON.stringify({root,policy:'RETAIN_ALL',host:process.platform,windowsFilesystem:'NOT_RUN',pathPlatform:'win32 syntax injected; actual private host disk persistence'}));
  return root;
}

test('platform explicit absolute roots, device/relative/control/length boundaries',()=>{
  for(const p of ['C:\\','D:\\音频 素材\\音乐','c:/中文 空格/music','\\\\server\\share','\\\\server\\share\\音效','//server/share/folder','Z:\\'+'a'.repeat(1021)])assert.equal(isCloudAudioRootPath(p,'win32'),true,p);
  for(const p of ['','relative','C:relative','C:','\\rooted','/rooted','\\\\server','\\\\server\\','\\\\\\server\\share','\\\\server\\\\share','\\\\.\\pipe\\name','\\\\?\\C:\\music','//?/UNC/server/share','\\??\\C:\\music','\\\\..\\share','\\\\server\\..','\\\\server\\share.','\\\\server\\share ','C:\\bad\npath','C:\\bad\x00path','C:\\bad\x7fpath','C:\\'+'a'.repeat(1022)])assert.equal(isCloudAudioRootPath(p,'win32'),false,JSON.stringify(p));
  for(const p of ['/','/tmp/中文 空格','//posix-root','/'+'a'.repeat(1023)])assert.equal(isCloudAudioRootPath(p,'darwin'),true,p);
  for(const p of ['C:\\audio','relative','/bad\nroot','/'+'a'.repeat(1024),null])assert.equal(isCloudAudioRootPath(p,'linux'),false,JSON.stringify(p));
});

test('drive and UNC jobs survive real private disk close/reopen; queued interrupts, completed/provenance retained',async t=>{
  const root=await directory(t);
  for(const [i,rootPath] of ['D:\\中文 空格\\音乐','c:/音效/未归档','\\\\synthetic-host\\share\\中文 空格'].entries()){
    const dataDir=path.join(root,String(i));let store=new CloudAudioJobStore(dataDir,{pathPlatform:'win32'});t.after(()=>store.close());await store.init();
    const queued=await store.create(input(rootPath)),finished=await store.create(input(rootPath)),assetId=crypto.randomUUID();
    await store.complete(finished.id,{assetId,createdFile:true,receivedBytes:11068},{category:'系统验证',subcategory:'私有合成'});await store.close();
    const before=JSON.parse(await fs.readFile(path.join(dataDir,'cloud-audio-jobs.json'),'utf8'));assert.equal(before.version,1);assert.equal(before.jobs.length,2);assert.ok(before.jobs.every(x=>x.rootPath===rootPath));
    store=await new CloudAudioJobStore(dataDir,{pathPlatform:'win32'}).init();assert.equal(store.interruptedCount,1);assert.equal(store.get(queued.id).state,'interrupted');assert.equal(store.get(queued.id).errorCode,'INTERRUPTED');assert.equal(store.get(queued.id).rootPath,rootPath);assert.equal(store.get(finished.id).state,'completed');assert.equal(store.get(finished.id).rootPath,rootPath);assert.equal(store.get(finished.id).assetId,assetId);assert.equal(store.provenance(assetId).sha256,finished.sha256);await store.close();
    const persisted=JSON.parse(await fs.readFile(path.join(dataDir,'cloud-audio-jobs.json'),'utf8'));assert.equal(persisted.jobs.find(x=>x.id===queued.id).state,'interrupted');assert.ok(persisted.jobs.every(x=>x.rootPath===rootPath));
    store=await new CloudAudioJobStore(dataDir,{pathPlatform:'win32'}).init();assert.equal(store.interruptedCount,0);assert.equal(store.list().length,2);assert.equal(store.get(finished.id).state,'completed');await store.close();
  }
});

test('invalid create/update cannot replace persisted root; no cross-platform path migration',async t=>{
  const root=await directory(t),win=await new CloudAudioJobStore(path.join(root,'windows'),{pathPlatform:'win32'}).init();t.after(()=>win.close());
  const job=await win.create(input('E:\\合成 音频'));
  for(const p of ['C:relative','\\\\server','\\\\?\\C:\\audio','C:\\bad\nroot','/posix']){await assert.rejects(win.create(input(p)),/invalid job/);await assert.rejects(win.update(job.id,{rootPath:p}),/invalid job update/);}
  assert.equal(win.list().length,1);assert.equal(win.get(job.id).rootPath,'E:\\合成 音频');const persisted=JSON.parse(await fs.readFile(path.join(root,'windows','cloud-audio-jobs.json'),'utf8'));assert.equal(persisted.jobs[0].rootPath,'E:\\合成 音频');
  const posix=await new CloudAudioJobStore(path.join(root,'posix'),{pathPlatform:'darwin'}).init();t.after(()=>posix.close());await assert.rejects(posix.create(input('C:\\audio')),/invalid job/);const old=await posix.create(input('/tmp/合成 root'));await posix.close();const reopened=await new CloudAudioJobStore(path.join(root,'posix'),{pathPlatform:'darwin'}).init();t.after(()=>reopened.close());assert.equal(reopened.get(old.id).rootPath,'/tmp/合成 root');assert.equal(reopened.get(old.id).state,'interrupted');
});
