// Observations from disposable fixtures only; no App, library, network or desktop launch.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
const exec=promisify(execFile);
const safeError=e=>({code:/^[A-Z0-9_]+$/.test(String(e.code))?e.code:'PROBE_ERROR'});
async function probe({output=path.resolve('reports/windows-probe')}={}) {
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'shiguang-win-probe-')));
 const results=[];
 const check=async(id,fn)=>{try{results.push({id,status:'observed',result:await fn()});}catch(e){results.push({id,status:'failed',error:safeError(e)});}};
 const command=async(exe,args,options={})=>{if(options.stdio)return new Promise(resolve=>{const child=spawn(exe,args,{...options,windowsHide:true});let stdout='',done=false;const timer=setTimeout(()=>child.kill('SIGTERM'),20000);const finish=result=>{if(done)return;done=true;clearTimeout(timer);resolve(result);};child.stdout.on('data',b=>{if(stdout.length<1024*1024)stdout+=b;});child.stderr.on('data',()=>{});child.once('error',e=>finish({ok:false,...safeError(e)}));child.once('close',(code,signal)=>finish(code===0&&!signal?{ok:true,stdout}:{ok:false,code:signal?'TOOL_TIMEOUT':'TOOL_FAILED'}));});try{const r=await exec(exe,args,{timeout:20000,maxBuffer:1024*1024,windowsHide:true,...options});return{ok:true,stdout:r.stdout};}catch(e){return{ok:false,...safeError(e)};}};
 try {
  await check('directory-fsync',async()=>{let h;try{h=await fs.open(root,'r');await h.sync();return{supported:true};}catch(e){return{supported:false,...safeError(e)};}finally{await h?.close();}});
  await check('stat-and-inode',async()=>{const f=path.join(root,'identity');await fs.writeFile(f,'synthetic');const normal=await fs.stat(f),big=await fs.stat(f,{bigint:true});return{mode:normal.mode,uid:normal.uid,getuidAvailable:typeof process.getuid==='function',inodeExact:BigInt(normal.ino)===big.ino,inodeBeyondSafeInteger:big.ino>BigInt(Number.MAX_SAFE_INTEGER)};});
  await check('rename-over-empty-directory',async()=>{const from=path.join(root,'source'),to=path.join(root,'empty-target');await fs.mkdir(from);await fs.mkdir(to);await fs.writeFile(path.join(from,'owned.txt'),'fixture');try{await fs.rename(from,to);return{renamed:true,payloadPreserved:await fs.readFile(path.join(to,'owned.txt'),'utf8')==='fixture'};}catch(e){return{renamed:false,...safeError(e),sourcePreserved:await fs.readFile(path.join(from,'owned.txt'),'utf8')==='fixture'};}});
  await check('reserved-names',async()=>{const entries=[];for(const name of ['colon:name','CON','NUL','AUX','COM1']){
   // Separate bounded process: a device-name open must never hang the coordinator.
   const code=`const fs=require('node:fs');let fd;try{fd=fs.openSync(process.argv[1],'wx');const regular=fs.fstatSync(fd).isFile();if(regular)fs.writeSync(fd,'owned');fs.closeSync(fd);fd=undefined;let removed=false;if(regular){fs.unlinkSync(process.argv[1]);removed=true;}console.log(JSON.stringify({created:true,regular,removed}));}catch(e){if(fd!==undefined)fs.closeSync(fd);console.log(JSON.stringify({created:false,code:/^[A-Z0-9_]+$/.test(String(e.code))?e.code:'ERROR'}));}`;
   const r=await command(process.execPath,['-e',code,path.join(root,name)]);entries.push({name,...(r.ok?JSON.parse(r.stdout):r)});
  }return entries;});
  await check('long-path',async()=>{let dir=root;while(dir.length<310)dir=path.join(dir,'long-segment-1234567890');await fs.mkdir(dir,{recursive:true});const file=path.join(dir,'中文-🎬.txt');await fs.writeFile(file,'owned');const r=await command(process.execPath,['-e',"process.stdout.write('cwd-ok')"],{cwd:dir});return{lengthOver260:file.length>260,readback:await fs.readFile(file,'utf8')==='owned',realpath:!!(await fs.realpath(file)),childCwd:r.ok&&r.stdout==='cwd-ok'};});
  await check('open-file-rename-unlink',async()=>{const file=path.join(root,'held.txt'),moved=path.join(root,'held-moved.txt');await fs.writeFile(file,'owned');const child=spawn(process.execPath,['-e',"const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'r');process.send('ready');const finish=()=>{fs.closeSync(fd);process.disconnect();};const t=setTimeout(finish,5000);process.once('message',()=>{clearTimeout(t);finish();});",file],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});const exited=once(child,'exit');await once(child,'message');let rename,unlink;try{await fs.rename(file,moved);rename={ok:true};}catch(e){rename={ok:false,...safeError(e)};}try{await fs.unlink(rename.ok?moved:file);unlink={ok:true};}catch(e){unlink={ok:false,...safeError(e)};}child.send('close');const [exitCode]=await exited;return{rename,unlink,ownerExited:exitCode===0};});
  const ffmpeg=process.env.WINDOWS_PROBE_FFMPEG||'ffmpeg',ffprobe=process.env.WINDOWS_PROBE_FFPROBE||'ffprobe',exiftool=process.env.WINDOWS_PROBE_EXIFTOOL||'exiftool';
  const media=path.join(root,'中文-🎬-media.mp4');let generated=false;
  await check('ffmpeg-unicode',async()=>{const r=await command(ffmpeg,['-v','error','-nostdin','-f','lavfi','-i','color=c=green:s=64x64:r=5:d=1','-c:v','mpeg4',media]);generated=r.ok;return{ok:r.ok,...(!r.ok?{code:r.code}:{})};});
  await check('ffprobe-unicode',async()=>{if(!generated)throw Error('fixture unavailable');const r=await command(ffprobe,['-v','error','-show_entries','format=duration','-of','json',media]);return{ok:r.ok,durationKnown:r.ok&&Number(JSON.parse(r.stdout).format?.duration)>0,...(!r.ok?{code:r.code}:{})};});
  await check('ffmpeg-unicode-read',async()=>{if(!generated)throw Error('fixture unavailable');const r=await command(ffmpeg,['-v','error','-nostdin','-i',media,'-f','null','-']);return{ok:r.ok,...(!r.ok?{code:r.code}:{})};});
  await check('exiftool-unicode',async()=>{if(!generated)throw Error('fixture unavailable');const r=await command(exiftool,['-charset','filename=utf8','-j','-FileType',media]);return{ok:r.ok,type:r.ok?JSON.parse(r.stdout)[0]?.FileType:null,...(!r.ok?{code:r.code}:{})};});
  await check('ffprobe-pipe3-tail-moov',async()=>{if(!generated)throw Error('fixture unavailable');const bytes=await fs.readFile(media);const tailMoov=bytes.indexOf(Buffer.from('moov'))>bytes.indexOf(Buffer.from('mdat'));const h=await fs.open(media,'r');try{const r=await command(ffprobe,['-v','error','-show_entries','format=duration','-of','json','pipe:3'],{stdio:['ignore','pipe','pipe',h.fd]});return{tailMoov,ok:r.ok,durationKnown:r.ok&&Number(JSON.parse(r.stdout).format?.duration)>0,...(!r.ok?{code:r.code}:{})};}finally{await h.close();}});
  results.push({id:'explorer-dpi-install-ui',status:'desktop_only',reason:'CI不启动资源管理器；实际桌面打开、DPI、安装及窗口遮挡需Windows真机确认'});
 } finally {
  // Keep only generated reports in the artifact; never include the private root or files.
  await fs.mkdir(output,{recursive:true});
  const report={format:1,platform:process.platform,node:process.version,fixtures:'synthetic-only',temporaryFiles:'retained-outside-artifact',results};
  await fs.writeFile(path.join(output,'probe.json'),JSON.stringify(report,null,2));
  await fs.writeFile(path.join(output,'摘要.md'),'# Windows阶段0探针\n\n平台：'+process.platform+'；Node：'+process.version+'。仅合成临时夹具，不启动拾光、不访问原库或系统废纸篓。\n\n'+results.map(r=>'- '+r.id+'：'+(r.status==='desktop_only'?'仅真机可测':r.status==='failed'?'探针失败 '+r.error.code:JSON.stringify(r.result))).join('\n')+'\n\n观测结果不等于产品修复通过；失败项保留，桌面行为不从CI推断。\n');
 }
 return results.some(r=>r.status==='failed')?1:0;
}
probe({output:process.argv[2]||undefined}).then(code=>{process.exitCode=code;}).catch(()=>{console.error('WINDOWS_PROBE_FAILED');process.exitCode=1;});
