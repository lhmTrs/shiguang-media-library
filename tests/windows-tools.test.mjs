import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {readExiftool} from '../server/exiftool-read.mjs';
import {EventEmitter} from 'node:events';
import {tempDirectories} from './helpers/temp-cleanup.mjs';
import {mediaCommand} from '../server/media-tool.mjs';
import {findCodex} from '../server/prompt-codex/transport.mjs';
import {revealWindows,runMedia} from '../server/media-process.mjs';
const temporary=tempDirectories(test,'windows-tools-');
const put=async file=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,'synthetic-discovery-only');return file;};
test('Windows Codex skips earlier cmd, chooses native PATH, then npm vendor without executing shims',async t=>{
 const dir=await temporary(t),early=path.join(dir,'early'),late=path.join(dir,'late');
 await put(path.join(early,'codex.cmd'));const native=await put(path.join(late,'codex.exe'));
 const options={platform:'win32',arch:'x64',env:{PATH:[early,late].join(';')}};
 assert.equal(await findCodex(options),native);await fs.unlink(native);
 const vendor=await put(path.join(early,'node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe'));
 assert.equal(await findCodex(options),vendor);
 await assert.rejects(findCodex({...options,env:{MEDIA_CODEX_BIN:path.join(early,'codex.cmd')}}),{code:'CODEX_NATIVE_BINARY_REQUIRED'});
 await assert.rejects(findCodex({...options,env:{MEDIA_CODEX_BIN:path.join(early,'absent.exe')}}),{code:'CODEX_NOT_INSTALLED'});
 assert.equal(await findCodex({...options,env:{MEDIA_CODEX_BIN:vendor}}),await fs.realpath(vendor));
});
test('media discovery resolves exe and explicit paths, rejects shim/missing override, keeps Mac route',async t=>{
 const dir=await temporary(t),early=path.join(dir,'early'),late=path.join(dir,'late');await put(path.join(early,'ffmpeg.cmd'));
 const file=await put(path.join(late,'ffmpeg.exe')),env={PATH:[early,late].join(';')};
 assert.equal(mediaCommand('ffmpeg',{env,platform:'win32'}),await fs.realpath(file));
 assert.equal(mediaCommand('ffmpeg',{env:{MEDIA_FFMPEG_BIN:file},platform:'win32'}),await fs.realpath(file));
 assert.throws(()=>mediaCommand('ffmpeg',{env:{...env,MEDIA_FFMPEG_BIN:path.join(dir,'absent.exe')},platform:'win32'}),{code:'ENOENT'});
 assert.throws(()=>mediaCommand('ffmpeg',{env:{MEDIA_FFMPEG_BIN:'ffmpeg.cmd'},platform:'win32'}),{code:'EINVAL'});
 assert.equal(mediaCommand('ffmpeg',{env:{MEDIA_FFMPEG_BIN:file},platform:'darwin'}),'ffmpeg');
});
test('Explorer acknowledges spawn, ignores later nonzero exit, rejects failed creation (desktop unverified)',async()=>{
 let child,args,options;const spawnImpl=(cmd,a,o)=>{assert.equal(cmd,'explorer.exe');args=a;options=o;child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;};
 assert.deepEqual(await revealWindows('C:\\中文 空格\\file.mp4',{spawnImpl}),{status:'spawned',desktopVerified:false});
 assert.deepEqual(args,['/select,C:\\中文 空格\\file.mp4']);assert.equal(options.shell,false);child.emit('exit',1);
 await assert.rejects(revealWindows('unused',{spawnImpl:()=>{const c=new EventEmitter();queueMicrotask(()=>c.emit('error',Object.assign(Error(),{code:'ENOENT'})));return c;}}),{code:'ENOENT'});
});
test('Windows native media override preserves argument boundaries without shell', {skip:process.platform!=='win32'},async()=>{
 const {stdout}=await runMedia('ffmpeg',['-e','process.stdout.write(JSON.stringify(process.argv.slice(1)))','中文 🎬 & $x'],{env:{...process.env,MEDIA_FFMPEG_BIN:process.execPath}});
 assert.deepEqual(JSON.parse(stdout),['中文 🎬 & $x']);
});
test('Windows installed media tools read a synthetic Unicode filename', {skip:process.platform!=='win32'||process.env.WINDOWS_MEDIA_SMOKE!=='1'},async t=>{
 const dir=await temporary(t),file=path.join(dir,'合成 🎬.mp4');
 await runMedia('ffmpeg',['-v','error','-nostdin','-f','lavfi','-i','color=c=green:s=64x64:r=5:d=1','-c:v','mpeg4',file],{timeout:20000});
 const {stdout}=await runMedia('ffprobe',['-v','error','-show_entries','format=duration','-of','json',file],{timeout:10000});assert.ok(Number(JSON.parse(stdout).format.duration)>0);
 try{const {stdout}=await readExiftool(file,['-j','-FileType'],{timeout:10000});assert.equal(JSON.parse(stdout)[0].FileType,'MP4');}catch(e){console.log('Synthetic ExifTool diagnostic:',String(e.stderr||e.code).replaceAll(dir,'<owned-fixture>').slice(0,1000));throw Error('WINDOWS_EXIFTOOL_UNICODE_FAILED');}
});
