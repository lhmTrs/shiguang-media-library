// Exact executable discovery only. No shell/shim, install, recursive search or env dump.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const tools=new Set(['ffmpeg','ffprobe','exiftool']);
const bundled=fileURLToPath(new URL('../tools/',import.meta.url));
export function mediaCommand(name,{env=process.env,platform=process.platform,defaults}={}) {
 if(!tools.has(name)||platform!=='win32')return name;
 const configured=env['MEDIA_'+name.toUpperCase()+'_BIN']??(name==='ffprobe'?env.MEDIA_STORYBOARD_FFPROBE:undefined);
 const command=configured??name;
 if(typeof command!=='string'||!command.trim()||/[\x00-\x1f\x7f]/.test(command)||command.length>8192||/\.(cmd|bat|ps1)$/i.test(command))throw Object.assign(Error('媒体工具配置无效，请选择原生可执行文件'),{code:'EINVAL'});
 const isPath=/[\\/]/.test(command)||path.isAbsolute(command);
 if(isPath&&!path.isAbsolute(command))throw Object.assign(Error('媒体工具必须使用绝对路径'),{code:'EINVAL'});
 const names=path.extname(command)?[command]:[command+'.exe'];
 const directories=String(env.PATH||env.Path||'').split(';').map(d=>d.replace(/^"(.*)"$/,'$1')).filter(d=>path.isAbsolute(d)).slice(0,256);
 const candidates=isPath?[command]:[...directories.flatMap(d=>names.map(n=>path.join(d,n))),...(configured===undefined?(defaults??[path.join(bundled,name+'.exe')]):[])];
 let significant;
 for(const candidate of [...new Set(candidates)])try{const real=fs.realpathSync(candidate);if(!/\.exe$/i.test(real)||!fs.statSync(real).isFile())throw Object.assign(Error(),{code:'EACCES'});return real;}catch(e){if(!['ENOENT','ENOTDIR'].includes(e.code))significant=e;}
 throw Object.assign(Error('未找到可用 '+name+'，请在 doctor 中核对原生工具配置'),{code:significant?.code??'ENOENT'});
}
