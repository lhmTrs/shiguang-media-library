import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {PHOTO,VIDEO,AUDIO} from '../server/fs-identity.mjs';
import {Receipts,inspectSelection,selectionHash,revalidateSelection,stamp} from '../server/file-intake/files.mjs';
import {IntakeNative,workflow,plist,shellQuote} from '../server/file-intake/native.mjs';
import {FileIntake} from '../server/file-intake/store.mjs';

// Synthetic files only. Every installer has an explicit tempServicesDir and a
// compiler stub that writes bytes, never executes a process or registers a
// service. No Finder, native window, running product or real media is used.
async function fixture(t) {
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-media-native-')));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const dataDir=path.join(dir,'data'),project=path.join(dir,'project');
  const tempServicesDir=path.join(dir,'Services');
  const calls=[];
  const native=new IntakeNative({dataDir,project,personalItemDirectory:path.join(dir,'personal_item'),
    servicesDirectory:tempServicesDir,platform:'darwin',runner:async(command,args)=>{
      calls.push({command,args});assert.equal(command,'/usr/bin/swiftc');
      await fs.writeFile(args[args.indexOf('-o')+1],'synthetic helper; never execute');
      return {stdout:'',stderr:''};
    }});
  // Simulate supported macOS regardless of the test host/container settings.
  t.mock.method(native,'supported',()=>true);
  const receipts=await new Receipts(dataDir).init();
  const file=async(name,bytes='owned synthetic source')=>{const p=path.join(dir,name);await fs.writeFile(p,bytes);return p;};
  const installOwned=async({target=native.legacyTarget,marker={},movie=true}={})=>{
    await fs.mkdir(path.join(target,'Contents/Resources'),{recursive:true});
    await fs.writeFile(path.join(target,'Contents/shiguang-install.json'),JSON.stringify({
      owner:'shiguang-file-intake-v1',project,dataDir,...marker}));
    await fs.writeFile(path.join(target,'Contents/Info.plist'),plist({NSServices:[{NSSendFileTypes:movie?['public.movie']:['public.image','public.movie','public.audio']}]}));
    await fs.writeFile(path.join(target,'Contents/Resources/document.wflow'),'owned predecessor bytes');
    return target;
  };
  return {dir,dataDir,project,tempServicesDir,native,calls,receipts,file,installOwned};
}
const selectionError=e=>e.code==='INTAKE_VIDEO_ONLY'&&/照片、视频或音频/.test(e.message);

test('all canonical extensions, mixed kinds, case and duplicates retain exact source identity',async t=>{
  const f=await fixture(t),inputs=[],kinds=[];
  for(const [extensions,kind] of [[PHOTO,'photo'],[VIDEO,'video'],[AUDIO,'audio']]){
    for(const ext of extensions){inputs.push(await f.file('source.'+ext.toUpperCase()));kinds.push(kind);}
  }
  const selected=await inspectSelection([...inputs,inputs[0]]);
  assert.equal(selected.length,inputs.length);assert.deepEqual(selected.map(v=>v.mediaKind),kinds);
  assert.equal(new Set(selected.map(v=>v.id)).size,inputs.length);
  const parent=await fs.lstat(f.dir);
  for(let i=0;i<selected.length;i++){
    const entry=selected[i];assert.equal(entry.path,inputs[i]);assert.equal(entry.name,path.basename(inputs[i]));
    assert.deepEqual(entry.identity,stamp(await fs.lstat(inputs[i])));
    assert.deepEqual(entry.parentIdentity,{dev:String(parent.dev),ino:String(parent.ino)});
    assert.equal(entry.bytes,Buffer.byteLength('owned synthetic source'));
  }
  assert.ok(selected.filter(v=>AUDIO.has(path.extname(v.path).slice(1).toLowerCase())).every(v=>v.mediaKind==='audio'));
});

test('any unsupported file, empty file, directory or link rejects the entire handoff before a receipt',async t=>{
  const f=await fixture(t),photo=await f.file('photo.jpg'),video=await f.file('clip.mp4'),audio=await f.file('sound.wav');
  const text=await f.file('unsupported.txt'),empty=await f.file('empty.png',''),directory=path.join(f.dir,'folder.mp4');
  await fs.mkdir(directory);
  const rejected=[text,empty,directory];
  if(process.platform!=='win32'){
    const link=path.join(f.dir,'linked.jpg');await fs.symlink(photo,link);rejected.push(link);
    const linkedDirectory=path.join(f.dir,'linked-folder');await fs.symlink(directory,linkedDirectory);rejected.push(linkedDirectory);
  }
  for(const item of rejected){
    await assert.rejects(f.receipts.handoff([photo,video,audio,item]),selectionError);
    await assert.rejects(f.receipts.handoff([item,photo,video,audio]),selectionError);
    assert.deepEqual(await fs.readdir(path.join(f.receipts.base,'handoffs')),[]);
  }
  for(const invalid of [[],null,'file.jpg',['relative.jpg'],[photo,null],[photo+'\0']])
    await assert.rejects(inspectSelection(invalid),selectionError);
  for(const file of [photo,video,audio])assert.equal(await fs.readFile(file,'utf8'),'owned synthetic source');
});

test('mixed handoffs persist kinds and hash proofs; legacy kindless video receipts still read as video',async t=>{
  const f=await fixture(t),files=await Promise.all(['photo.png','clip.mov','sound.aiff'].map(name=>f.file(name)));
  const h=await f.receipts.handoff(files,{deferFingerprint:true});
  assert.equal(h.preparation,'checking');assert.ok(h.files.every(v=>!v.selectionSha256));
  const ready=await f.receipts.prepareHandoff(h.id);
  assert.equal(ready.preparation,'ready');assert.deepEqual(ready.files.map(v=>v.mediaKind),['photo','video','audio']);
  for(const entry of ready.files){
    assert.equal(entry.selectionSha256,createHash('sha256').update(await fs.readFile(entry.path)).digest('hex'));
    assert.deepEqual(await revalidateSelection(entry),entry.identity);
  }
  const old=await f.receipts.handoff([files[1]]);delete old.files[0].mediaKind;
  await f.receipts.write('handoffs',old.id,old);
  const context={receipts:f.receipts,batches:new Map(),projects:{list:()=>[]},canTrash:false};
  const dto=await FileIntake.prototype.handoff.call(context,old.id);
  assert.equal(dto.files[0].mediaKind,'video');
  const raw=await f.receipts.read('handoffs',old.id);assert.equal(raw.files[0].mediaKind,undefined);
  assert.deepEqual(await revalidateSelection(raw.files[0]),raw.files[0].identity);
});

test('photo and audio hashes still use a held descriptor, NOFOLLOW and NONBLOCK and close it',async t=>{
  const f=await fixture(t);
  for(const name of ['proof.png','proof.wav']){
    const file=await f.file(name),entry=(await inspectSelection([file]))[0];
    const open=fs.open;let opened=0,closed=0;
    const mock=t.mock.method(fs,'open',async(p,flags,...rest)=>{
      const handle=await open(p,flags,...rest);
      if(p===file){
        opened++;assert.equal(flags,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        const close=handle.close.bind(handle);handle.close=async()=>{closed++;return close();};
      }
      return handle;
    });
    try{assert.equal(await selectionHash(entry),createHash('sha256').update('owned synthetic source').digest('hex'));}
    finally{mock.mock.restore();}
    assert.equal(opened,1);assert.equal(closed,1);
    const controller=new AbortController();controller.abort();
    await assert.rejects(selectionHash(entry,{signal:controller.signal}),e=>e.name==='AbortError');
  }
});

test('changed source bytes or replaced parent directory never acquire ready media proofs',async t=>{
  const f=await fixture(t),photo=await f.file('photo.heic'),audio=await f.file('sound.flac');
  const changed=await f.receipts.handoff([photo,audio],{deferFingerprint:true});
  await fs.appendFile(audio,'changed');
  await assert.rejects(f.receipts.prepareHandoff(changed.id),e=>e.code==='INTAKE_SOURCE_CHANGED');
  const failed=await f.receipts.read('handoffs',changed.id);
  assert.equal(failed.preparation,'failed');assert.match(failed.preparationError,/原文件/);
  assert.equal(failed.files[1].selectionSha256,undefined);
  const parent=path.join(f.dir,'source-parent');await fs.mkdir(parent);
  const file=path.join(parent,'source.png');await fs.writeFile(file,'owned proof');
  const entry=(await inspectSelection([file]))[0];
  await fs.rename(parent,parent+'-kept');await fs.mkdir(parent);await fs.rename(path.join(parent+'-kept','source.png'),file);
  await assert.rejects(selectionHash(entry),e=>e.code==='INTAKE_SOURCE_CHANGED');
  assert.equal(await fs.readFile(file,'utf8'),'owned proof');
});

test('generic workflow forwards quoted CLI arguments with a broad file input',()=>{
  const doc=workflow("/a'b/node",'/project/script with spaces.mjs','/private/config.json');
  assert.equal(doc.workflowMetaData.serviceInputTypeIdentifier,'com.apple.Automator.fileSystemObject');
  assert.equal(doc.workflowMetaData.serviceApplicationBundleID,'com.apple.finder');
  assert.equal(doc.workflowMetaData.serviceOutputTypeIdentifier,'com.apple.Automator.nothing');
  assert.equal(doc.actions[0].action.ActionParameters.COMMAND_STRING,
    'exec '+["/a'b/node",'/project/script with spaces.mjs','--config','/private/config.json','--'].map(shellQuote).join(' ')+' "$@"');
  assert.match(plist(doc),/script with spaces/);
});

test('status and construction do not prepare a helper or install any workflow',async t=>{
  const f=await fixture(t);
  assert.deepEqual(await f.native.status(),{supported:true,installed:false,upgradeNeeded:false});
  assert.deepEqual(f.calls,[]);
  await assert.rejects(fs.access(f.tempServicesDir),e=>e.code==='ENOENT');
  await assert.rejects(fs.access(f.native.nativeDir),e=>e.code==='ENOENT');
});

test('owned movie-only predecessor is installed but needs an explicit upgrade',async t=>{
  const f=await fixture(t),old=await f.installOwned();
  assert.deepEqual(await f.native.status(),{supported:true,installed:true,upgradeNeeded:true});
  assert.deepEqual(f.calls,[]);await fs.access(old);
  await assert.rejects(fs.access(f.native.target),e=>e.code==='ENOENT');
  const result=await f.native.install();assert.equal(result.installed,true);assert.equal(result.upgradeNeeded,false);
  assert.match(result.message,/收纳素材到拾光/);assert.match(result.message,/音乐或音效/);
  assert.deepEqual(await f.native.status(),{supported:true,installed:true,upgradeNeeded:false});
  assert.equal(f.calls.length,1);
  await assert.rejects(fs.access(old),e=>e.code==='ENOENT');
  const names=await fs.readdir(f.tempServicesDir);
  assert.deepEqual(names.filter(v=>v.endsWith('.workflow')),['收纳素材到拾光.workflow']);
  const backups=names.filter(v=>v.startsWith('.shiguang-intake-previous-'));assert.equal(backups.length,1);
  assert.equal(await fs.readFile(path.join(f.tempServicesDir,backups[0],'Contents/Resources/document.wflow'),'utf8'),'owned predecessor bytes');
  const info=await fs.readFile(path.join(f.native.target,'Contents/Info.plist'),'utf8');
  assert.match(info,/<key>NSSendFileTypes<\/key><array><string>public.image<\/string><string>public.movie<\/string><string>public.audio<\/string><\/array>/);
  assert.match(info,/<key>NSMenuItem<\/key><dict><key>default<\/key><string>收纳素材到拾光<\/string>/);
  const marker=JSON.parse(await fs.readFile(path.join(f.native.target,'Contents/shiguang-install.json'),'utf8'));
  assert.equal(marker.version,2);assert.deepEqual(marker.mediaKinds,['photo','video','audio']);
  const document=await fs.readFile(path.join(f.native.target,'Contents/Resources/document.wflow'),'utf8');
  assert.match(document,/finder-intake.mjs/);assert.doesNotMatch(document,/fileSystemObject.movie/);
});

test('concurrent explicit install requests share one compiler and one publication',async t=>{
  const f=await fixture(t),a=f.native.install(),b=f.native.install();assert.equal(a,b);
  await Promise.all([a,b]);assert.equal(f.calls.length,1);
  assert.deepEqual((await fs.readdir(f.tempServicesDir)).filter(v=>v.endsWith('.workflow')),['收纳素材到拾光.workflow']);
  await f.native.install();assert.equal(f.calls.length,1,'unchanged helper may be reused');
  assert.deepEqual(await f.native.status(),{supported:true,installed:true,upgradeNeeded:false});
});

test('same-title legacy markers and duplicate owned movie entries upgrade together',async t=>{
  const f=await fixture(t);await f.installOwned({target:f.native.target});await f.installOwned();
  assert.equal((await f.native.status()).upgradeNeeded,true);
  await f.native.install();assert.equal((await f.native.status()).upgradeNeeded,false);
  assert.deepEqual((await fs.readdir(f.tempServicesDir)).filter(v=>v.endsWith('.workflow')),['收纳素材到拾光.workflow']);
});

test('partial or malformed media capability markers still require an upgrade',async t=>{
  const f=await fixture(t);
  for(const mediaKinds of [undefined,1,'photo,video,audio',['video'],['photo','video']]){
    await f.installOwned({target:f.native.target,marker:{version:2,mediaKinds}});
    assert.deepEqual(await f.native.status(),{supported:true,installed:true,upgradeNeeded:true});
  }
  assert.deepEqual(f.calls,[]);
});

for(const variant of ['other project','other library','missing marker','malformed marker','symlink','linked marker','linked Contents'])
test('explicit install preserves conflicting generic entry: '+variant,async t=>{
  if(process.platform==='win32'&&variant.includes('link'))return t.skip('symlink privileges vary on Windows');
  const f=await fixture(t);await f.installOwned();
  const foreign=path.join(f.dir,'foreign.workflow');
  if(variant==='symlink'){
    await fs.mkdir(foreign);await fs.symlink(foreign,f.native.target);
  }else{
    await f.installOwned({target:f.native.target,marker:variant==='other project'?{project:'/another-project'}:variant==='other library'?{dataDir:'/another-library'}:{}});
    const marker=path.join(f.native.target,'Contents/shiguang-install.json');
    if(variant==='missing marker')await fs.unlink(marker);
    if(variant==='malformed marker')await fs.writeFile(marker,'{invalid');
    if(variant==='linked marker'){await fs.rename(marker,path.join(f.dir,'marker'));await fs.symlink(path.join(f.dir,'marker'),marker);}
    if(variant==='linked Contents'){
      await fs.rename(path.join(f.native.target,'Contents'),foreign);await fs.symlink(foreign,path.join(f.native.target,'Contents'));
    }
  }
  const before=stamp(await fs.lstat(f.native.target));
  await assert.rejects(f.native.install(),e=>e.code==='INTAKE_INSTALL_CONFLICT');
  assert.deepEqual(stamp(await fs.lstat(f.native.target)),before);assert.deepEqual(f.calls,[]);
  await fs.access(f.native.legacyTarget);
});

test('an unrelated old video service is left alone during generic installation',async t=>{
  const f=await fixture(t);await f.installOwned({marker:{project:'/another-project'}});
  assert.deepEqual(await f.native.status(),{supported:true,installed:false,upgradeNeeded:false});
  await f.native.install();await fs.access(f.native.legacyTarget);
  const marker=JSON.parse(await fs.readFile(path.join(f.native.legacyTarget,'Contents/shiguang-install.json'),'utf8'));
  assert.equal(marker.project,'/another-project');
});

for(const sameTitle of [false,true])test('publication failure rolls back the exact owned predecessor: '+(sameTitle?'generic title':'movie title'),async t=>{
  const f=await fixture(t),old=await f.installOwned({target:sameTitle?f.native.target:f.native.legacyTarget});
  const before=await fs.readFile(path.join(old,'Contents/Resources/document.wflow'));
  const rename=fs.rename;
  t.mock.method(fs,'rename',async(from,to)=>{
    if(path.dirname(from)===f.tempServicesDir&&path.basename(from).startsWith('.shiguang-intake-')&&from.endsWith('.workflow')&&to===f.native.target)
      throw Object.assign(Error('synthetic publication failure'),{code:'EIO'});
    return rename(from,to);
  });
  await assert.rejects(f.native.install(),/synthetic publication failure/);
  assert.deepEqual(await fs.readFile(path.join(old,'Contents/Resources/document.wflow')),before);
  assert.deepEqual(await f.native.status(),{supported:true,installed:true,upgradeNeeded:true});
  assert.deepEqual((await fs.readdir(f.tempServicesDir)).filter(v=>v.startsWith('.shiguang-intake-')),[]);
});

test('failure while backing up a second predecessor restores the first one',async t=>{
  const f=await fixture(t);await f.installOwned({target:f.native.target});await f.installOwned();
  const rename=fs.rename;
  t.mock.method(fs,'rename',async(from,to)=>{
    if(from===f.native.legacyTarget)throw Error('synthetic second backup failure');
    return rename(from,to);
  });
  await assert.rejects(f.native.install(),/synthetic second backup failure/);
  for(const target of [f.native.target,f.native.legacyTarget])
    assert.equal(await fs.readFile(path.join(target,'Contents/Resources/document.wflow'),'utf8'),'owned predecessor bytes');
  assert.deepEqual((await fs.readdir(f.tempServicesDir)).filter(v=>v.startsWith('.shiguang-intake-')),[]);
});

test('ownership is checked again if a predecessor changes during helper preparation',async t=>{
  const f=await fixture(t);await f.installOwned();const compile=f.native.run;
  f.native.run=async(...args)=>{
    await compile(...args);await fs.rename(f.native.legacyTarget,f.native.legacyTarget+'-kept');
    await f.installOwned({marker:{project:'/another-project'}});
  };
  await assert.rejects(f.native.install(),e=>e.code==='INTAKE_INSTALL_CONFLICT');
  const marker=JSON.parse(await fs.readFile(path.join(f.native.legacyTarget,'Contents/shiguang-install.json'),'utf8'));
  assert.equal(marker.project,'/another-project');await fs.access(f.native.legacyTarget+'-kept');
  await assert.rejects(fs.access(f.native.target),e=>e.code==='ENOENT');
});

test('a new generic entry appearing during preparation is never replaced',async t=>{
  const f=await fixture(t);await f.installOwned();const compile=f.native.run;
  f.native.run=async(...args)=>{
    await compile(...args);await fs.mkdir(f.native.target);await fs.writeFile(path.join(f.native.target,'unrelated'),'keep');
  };
  await assert.rejects(f.native.install(),e=>e.code==='INTAKE_INSTALL_CONFLICT');
  assert.equal(await fs.readFile(path.join(f.native.target,'unrelated'),'utf8'),'keep');
  assert.equal(await fs.readFile(path.join(f.native.legacyTarget,'Contents/Resources/document.wflow'),'utf8'),'owned predecessor bytes');
});

test('rollback stops at a concurrently occupied original name and retains its backup',async t=>{
  const f=await fixture(t);await f.installOwned();const rename=fs.rename;
  t.mock.method(fs,'rename',async(from,to)=>{
    if(from.endsWith('.workflow')&&path.basename(from).startsWith('.shiguang-intake-')&&to===f.native.target){
      await fs.mkdir(f.native.legacyTarget);await fs.writeFile(path.join(f.native.legacyTarget,'unrelated'),'keep');
      throw Object.assign(Error('synthetic publication failure'),{code:'EIO'});
    }
    return rename(from,to);
  });
  await assert.rejects(f.native.install(),e=>e.code==='INTAKE_INSTALL_ROLLBACK_FAILED'&&e.backups.length===1);
  assert.equal(await fs.readFile(path.join(f.native.legacyTarget,'unrelated'),'utf8'),'keep');
  const backups=(await fs.readdir(f.tempServicesDir)).filter(v=>v.startsWith('.shiguang-intake-previous-'));
  assert.equal(backups.length,1);assert.equal(await fs.readFile(path.join(f.tempServicesDir,backups[0],'Contents/Resources/document.wflow'),'utf8'),'owned predecessor bytes');
});

test('compiler failure leaves owned predecessor and no staging workflow',async t=>{
  const f=await fixture(t);await f.installOwned();f.native.run=async()=>{throw Error('synthetic compiler failure');};
  await assert.rejects(f.native.install(),e=>e.code==='INTAKE_COMPILER_UNAVAILABLE');
  assert.deepEqual(await fs.readdir(f.tempServicesDir),['收纳视频到拾光.workflow']);
  assert.deepEqual(await fs.readdir(f.native.nativeDir),[]);
});

test('closing during compilation never replaces or auto-upgrades the movie entry',async t=>{
  const f=await fixture(t);await f.installOwned();const compile=f.native.run;
  f.native.run=async(...args)=>{await compile(...args);f.native.beginClose();};
  await assert.rejects(f.native.install(),e=>e.code==='APPLICATION_CLOSING');
  assert.deepEqual(await fs.readdir(f.tempServicesDir),['收纳视频到拾光.workflow']);
  await f.native.close();
});

test('CLI and native shell keep exact consent and URL guards with generic media labels',async()=>{
  const cli=await fs.readFile(new URL('../scripts/finder-intake.mjs',import.meta.url),'utf8');
  const swift=await fs.readFile(new URL('../server/file-intake/window.swift',import.meta.url),'utf8');
  assert.match(cli,/acknowledgement\?\.action!=='start'\|\|acknowledgement.handoffId!==handoff.id/);
  assert.match(cli,/if\(flag!=='--config'\|\|separator!=='--'\)/);
  assert.match(cli,/receipts.handoff\(files,\{deferFingerprint:true\}\)/);
  assert.doesNotMatch(cli,/所选视频|使用收纳视频/);
  assert.match(swift,/window.title = "收纳素材到拾光"/);
  assert.match(swift,/window.initialFirstResponder = cancel/);
  assert.match(swift,/UUID\(uuidString:args\[2\]\) != nil/);
  assert.match(swift,/message.frameInfo.isMainFrame/);
  assert.match(swift,/url.host == "127.0.0.1"/);
});
