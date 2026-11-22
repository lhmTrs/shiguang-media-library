import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {mediaCommand} from './media-tool.mjs';
import {runMedia} from './media-process.mjs';
const stamp=s=>[String(s.dev),String(s.ino),s.size,s.mtimeMs,s.ctimeMs].join(':');
// Windows Perl rejects surrogate-pair filenames even with charset=utf8. Feed a
// held ordinary file over stdin, without renaming/copying it or using a shell.
export async function readExiftool(file,args,{timeout=20000,maxBuffer=2e6,env=process.env}={}) {
 if(process.platform!=='win32')return runMedia('exiftool',[...args,file],{timeout,maxBuffer,env});
 const named=await fs.lstat(file),real=await fs.realpath(file);
 if(!named.isFile()||named.isSymbolicLink())throw Object.assign(Error('拍摄日期文件身份已变化'),{code:'SOURCE_CHANGED'});
 const h=await fs.open(real,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
 try{
  const before=await h.stat();if(stamp(before)!==stamp(named))throw Object.assign(Error('拍摄日期文件身份已变化'),{code:'SOURCE_CHANGED'});
  const child=spawn(mediaCommand('exiftool',{env}),['-charset','filename=utf8',...args,'-'],{stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false,env});
  let timer,stdout='',stderr='';const ended=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Object.assign(Error('拍摄日期读取失败'),{code:'EXIFTOOL_FAILED'})));});
  child.stdout.on('data',b=>{stdout+=b;if(Buffer.byteLength(stdout)>maxBuffer)child.kill('SIGTERM');});
  child.stderr.on('data',b=>{if(stderr.length<1024)stderr+=b;});
  child.stdin.on('error',()=>{});
  timer=setTimeout(()=>child.kill('SIGTERM'),timeout);
  const streamed=pipeline(h.createReadStream({autoClose:false,start:0}),child.stdin).catch(e=>{if(e.code!=='EPIPE'&&e.code!=='ERR_STREAM_PREMATURE_CLOSE')throw e;});
  try{const results=await Promise.allSettled([streamed,ended]);for(const r of results)if(r.status==='rejected')throw r.reason;if(Buffer.byteLength(stdout)>maxBuffer)throw Error('拍摄日期结果超限');}
  finally{clearTimeout(timer);}
  if(stamp(await h.stat())!==stamp(before)||stamp(await fs.lstat(file))!==stamp(before)||await fs.realpath(file)!==real)throw Object.assign(Error('拍摄日期文件身份已变化'),{code:'SOURCE_CHANGED'});
  return{stdout,stderr};
 }finally{await h.close();}
}
