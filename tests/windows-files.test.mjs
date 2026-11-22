import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {once} from 'node:events';
import platformFs,{syncDir} from '../server/fs-platform.mjs';
import {execFile,spawn} from '../server/background-process.mjs';
import {privateDirectory,writePrivateJson,readPrivateJson} from '../server/storyboard-video-v2/upgrade-files.mjs';
import {writePrivate,readJson} from '../server/updream-progress/files.mjs';
import {VideoMedia} from '../server/storyboard-video/media.mjs';
import {tempDirectories} from './helpers/temp-cleanup.mjs';
const temporary=tempDirectories(test,'windows-files-'),run=promisify(execFile);
test('private file flushing, upgrade JSON and progress preferences read back on the actual platform',async t=>{
 const dir=await temporary(t),root=path.join(dir,'private');await privateDirectory(root);
 const a=path.join(root,'upgrade.json');await writePrivateJson(a,{owned:1});assert.deepEqual(await readPrivateJson(a),{owned:1});
 await writePrivateJson(a,{owned:2});assert.deepEqual(await readPrivateJson(a),{owned:2});
 const b=path.join(root,'preferences.json');await writePrivate(b,{owned:3});assert.deepEqual((await readJson(b,{privateMode:true})).value,{owned:3});await syncDir(root);
 const outside=path.join(dir,'other');await fs.mkdir(outside);const linked=path.join(dir,'linked');await fs.symlink(outside,linked,process.platform==='win32'?'junction':'dir');await assert.rejects(privateDirectory(linked));
});
test('background exec preserves native promisified stdout and argument boundaries',async()=>{
 const {stdout}=await run(process.execPath,['-e','process.stdout.write(JSON.stringify(process.argv.slice(1)))','中文 🎬 &x']);assert.deepEqual(JSON.parse(stdout),['中文 🎬 &x']);
});
test('Windows real denied rename is bounded, keeps both names and succeeds after owned lock is released',{skip:process.platform!=='win32'},async t=>{
 const dir=await temporary(t),source=path.join(dir,'owned.txt'),target=path.join(dir,'moved.txt');await fs.writeFile(source,'owned');
 const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$f=[IO.File]::Open($env:OWNED_LOCK_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None); [Console]::Out.WriteLine('ready'); [Console]::In.ReadLine() | Out-Null; $f.Dispose()"],{env:{...process.env,OWNED_LOCK_FILE:source},stdio:['pipe','pipe','pipe']});
 const exit=once(child,'close');let timer;const cleanup=()=>{clearTimeout(timer);child.stdin.end('close\n');};t.after(cleanup);timer=setTimeout(cleanup,5000);await once(child.stdout,'data');
 const started=Date.now();await assert.rejects(platformFs.rename(source,target),e=>['EPERM','EACCES','EBUSY'].includes(e.code)&&e.message==='文件正被其他程序使用，关闭后再试');assert.ok(Date.now()-started<4000);assert.equal(await fs.readFile(source,'utf8').catch(()=>null),null,'owner denies reads as well');await assert.rejects(fs.stat(target),{code:'ENOENT'});
 cleanup();assert.equal((await exit)[0],0);await platformFs.rename(source,target);assert.equal(await fs.readFile(target,'utf8'),'owned');
});
test('Windows held-input video probe reads Chinese emoji MP4 with trailing moov and settles all handles',{skip:process.platform!=='win32'||process.env.WINDOWS_MEDIA_SMOKE!=='1'},async t=>{
 const dir=await temporary(t),file=path.join(dir,'合成 🎬.mp4');await run('ffmpeg',['-v','error','-nostdin','-f','lavfi','-i','color=c=green:s=64x64:r=5:d=1','-c:v','libx264',file]);
 const bytes=await fs.readFile(file);assert.ok(bytes.indexOf('moov')>bytes.indexOf('mdat'));
 const media=new VideoMedia();const result=await media.probe(await fs.realpath(file),{includeDimensions:true});assert.equal(result.codec,'h264');assert.ok(result.durationMs>0);assert.equal(result.width,64);await media.close();assert.equal(media.handles.size,0);assert.equal(media.children.size,0);
});
