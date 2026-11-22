import {mediaCommand} from '../media-tool.mjs';
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const codes=new Set(['ENOENT','ENOTDIR','EACCES','EPERM','EMFILE','ENFILE','EAGAIN','ENOMEM','ENOEXEC','EINVAL','ETIMEDOUT','ERR_INVALID_ARG_TYPE','ERR_INVALID_ARG_VALUE','ERR_OUT_OF_RANGE']);
const reasons=new Set(['missing_tool','permission_denied','resource_exhausted','invalid_config','spawn_failed','timeout','probe_failed']);
const stages=new Set(['resolve','spawn','process']);
export function safeProbeDiagnostic(value){
 if(!value||!stages.has(value.stage)||!reasons.has(value.reason))return undefined;
 return {stage:value.stage,reason:value.reason,...(codes.has(value.causeCode)?{causeCode:value.causeCode}:{}),...(Number.isInteger(value.errno)&&Math.abs(value.errno)<=4096?{errno:value.errno}:{}),...(['spawn','access','stat','realpath'].includes(value.syscall)?{syscall:value.syscall}:{})};
}
export function probeFailure(cause,stage='spawn'){
 const code=codes.has(cause?.code)?cause.code:undefined;
 const reason=['ENOENT','ENOTDIR'].includes(code)?'missing_tool':['EACCES','EPERM'].includes(code)?'permission_denied':['EMFILE','ENFILE','EAGAIN','ENOMEM'].includes(code)?'resource_exhausted':['EINVAL','ERR_INVALID_ARG_TYPE','ERR_INVALID_ARG_VALUE','ERR_OUT_OF_RANGE'].includes(code)?'invalid_config':'spawn_failed';
 const diagnostic=safeProbeDiagnostic({stage,reason,causeCode:code,errno:cause?.errno,syscall:/^spawn(?: |$)/.test(cause?.syscall||'')?'spawn':cause?.syscall});
 const message={missing_tool:'未找到可用 ffprobe；请配置 MEDIA_STORYBOARD_FFPROBE 为可执行文件绝对路径，并重新启动本实例',permission_denied:'ffprobe 无执行权限或被系统策略阻止；请检查工具权限和本机安全策略',resource_exhausted:'视频探测资源暂不可用；请检查进程或文件句柄资源后重试',invalid_config:'视频探测工具配置无效；请检查 MEDIA_STORYBOARD_FFPROBE'}[reason]||'ffprobe 启动失败；请运行 npm run doctor 并核对视频探测工具配置';
 return Object.assign(Error(message),{code:'PROBE_UNAVAILABLE',status:503,diagnostic,details:{diagnostic}});
}
const bundled=fileURLToPath(new URL('../../tools/',import.meta.url));
export function defaultProbePaths(platform=process.platform){
 return [path.join(bundled,platform==='win32'?'ffprobe.exe':'ffprobe'),...(platform==='darwin'?['/opt/homebrew/bin/ffprobe','/usr/local/bin/ffprobe','/usr/bin/ffprobe']:platform==='win32'?[]:['/usr/local/bin/ffprobe','/usr/bin/ffprobe'])];
}
// Discover only known locations and the inherited executable search path. No
// shell, installation, recursive disk search, or environment mutation occurs.
export async function resolveVideoProbe({command='ffprobe',explicit=false,env=process.env,platform=process.platform,defaults=defaultProbePaths(platform)}={}){
 if(platform==='win32'&&command==='ffprobe'){try{return {command:mediaCommand('ffprobe',{env:explicit?{...env,MEDIA_FFPROBE_BIN:command}:env,platform,defaults})};}catch(e){throw probeFailure(e,'resolve');}}
 if(typeof command!=='string'||!command.trim()||/[\x00-\x1f\x7f]/.test(command)||command.length>8192)throw probeFailure({code:'EINVAL'},'resolve');
 const isPath=path.isAbsolute(command)||/[\\/]/.test(command);
 if(isPath&&!path.isAbsolute(command))throw probeFailure({code:'EINVAL'},'resolve');
 const delimiter=platform==='win32'?';':path.delimiter;
 const directories=String(env.PATH||'').split(delimiter).filter(p=>path.isAbsolute(p)).slice(0,256);
 const names=platform==='win32'&&!path.extname(command)?[command+'.exe']:[command];
 const candidates=isPath?[command]:[...directories.flatMap(dir=>names.map(name=>path.join(dir,name))),...(!explicit&&command==='ffprobe'?defaults:[])];
 let significant;
 for(const candidate of [...new Set(candidates)]){
  try{const real=await fs.realpath(candidate),st=await fs.stat(real);if(!st.isFile())throw Object.assign(Error(),{code:'EACCES',syscall:'stat'});await fs.access(real,platform==='win32'?constants.F_OK:constants.X_OK);return {command:real};}
  catch(e){if(!['ENOENT','ENOTDIR'].includes(e.code)){significant=e;if(isPath)break;}}
 }
 throw probeFailure(significant||{code:'ENOENT',syscall:'access'},'resolve');
}
