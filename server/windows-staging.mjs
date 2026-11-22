import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
const stamp=s=>({dev:String(s.dev),ino:String(s.ino),size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export async function allocateWindowsStage(target,prefix){
 if(process.platform!=='win32')throw Error('WINDOWS_ONLY');
 const parent=await fs.lstat(target);if(!parent.isDirectory()||parent.isSymbolicLink()||await fs.realpath(target)!==target)throw Error('STAGE_PARENT_CHANGED');
 const cache=await fs.realpath(await fs.mkdtemp(path.join(target,'.'+prefix)));
 const identity=stamp(await fs.lstat(cache)),after=await fs.lstat(target);
 if(String(after.dev)!==String(parent.dev)||String(after.ino)!==String(parent.ino)||identity.dev!==String(parent.dev)||path.dirname(cache)!==target)throw Error('STAGE_PARENT_CHANGED');
 return {cache,identity};
}
export async function cleanupWindowsStage({cache,cacheIdentity,stage,stageStat,target,verify}){
 if(process.platform!=='win32')throw Error('WINDOWS_ONLY');
 if(typeof verify!=='function'||path.dirname(cache)!==target||!/^\.shiguang-(project-video|reference)-import-/.test(path.basename(cache))||stage!==path.join(cache,'original.partial'))throw Error('STAGE_IDENTITY_UNKNOWN');
 const directory=await fs.lstat(cache);if(!directory.isDirectory()||directory.isSymbolicLink()||await fs.realpath(cache)!==cache||String(directory.dev)!==cacheIdentity.dev||String(directory.ino)!==cacheIdentity.ino||!same(stamp(await fs.lstat(stage)),stamp(stageStat)))throw Error('STAGE_IDENTITY_CHANGED');
 await verify();
 const child=spawn(process.execPath,[path.join(import.meta.dirname,'file-intake/cleanup-worker.mjs'),JSON.stringify({directory:cacheIdentity,stage:stamp(stageStat)})],{cwd:cache,stdio:['ignore','pipe','ignore'],windowsHide:true,shell:false});
 let output='',spawnError,timer;child.stdout.on('data',b=>{if(output.length<4096)output+=b;});child.once('error',e=>{spawnError=e;});
 const ended=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));timer=setTimeout(()=>child.kill('SIGTERM'),10000);
 try{const exit=await ended;if(spawnError||exit.code!==0||exit.signal||JSON.parse(output).stageRemoved!==true)throw Error('STAGE_CLEANUP_UNKNOWN');}finally{clearTimeout(timer);}
 const after=await fs.lstat(cache);if(!after.isDirectory()||after.isSymbolicLink()||String(after.dev)!==cacheIdentity.dev||String(after.ino)!==cacheIdentity.ino)throw Error('STAGE_IDENTITY_CHANGED');
 await fs.rmdir(cache);return {complete:true};
}
