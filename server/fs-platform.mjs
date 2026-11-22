import fs from 'node:fs/promises';
import path from 'node:path';
const key=s=>[String(s.dev),String(s.ino),s.size,s.mtimeMs,s.ctimeMs,s.isSymbolicLink()].join(':');
export const posixPrivate=(s,mask=0o077)=>process.platform==='win32'||(!(s.mode&mask)&&(!process.getuid||s.uid===process.getuid()));
export async function syncDir(directory,{guard=()=>{},flags='r'}={}) {
 if(process.platform!=='win32'){const h=await fs.open(directory,flags);try{guard();await h.sync();guard();}finally{await h.close();}return;}
 // Windows cannot open/fsync a directory with Node. File contents are still
 // synced by callers. Verify entries; never claim a directory flush occurred.
 guard();const before=await fs.lstat(directory);
 if(!before.isDirectory()||before.isSymbolicLink()||await fs.realpath(directory)!==directory)throw Object.assign(Error('目录位置已变化'),{code:'TARGET_CHANGED'});
 guard();const after=await fs.lstat(directory);
 if(key(before)!==key(after))throw Object.assign(Error('目录身份已变化'),{code:'TARGET_CHANGED'});guard();
}
async function snapshot(file){try{return key(await fs.lstat(file));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function retry(operation,files) {
 if(process.platform!=='win32')return operation();
 const paths=[...new Set([...files,...files.map(p=>path.dirname(p))])];
 const initial=await Promise.all(paths.map(snapshot));
 for(let attempt=0;;attempt++)try{return await operation();}catch(e){
  if(!['EBUSY','EPERM','EACCES'].includes(e.code))throw e;
  if(attempt===3){e.message='文件正被其他程序使用，关闭后再试';throw e;}
  await new Promise(r=>setTimeout(r,20*2**attempt));
  const current=await Promise.all(paths.map(snapshot));
  if(current.some((v,i)=>v!==initial[i]))throw Object.assign(Error('重试前文件或目录已变化，请重新核对'),{code:'TARGET_CHANGED'});
 }
}
// Local facade: never monkey-patch Node fs. Only bounded, unchanged-name retry;
// partially recursive removal is deliberately not retried.
const mutators={
 rename:(a,b)=>retry(()=>fs.rename(a,b),[a,b]),
 unlink:p=>retry(()=>fs.unlink(p),[p]),
 rmdir:p=>retry(()=>fs.rmdir(p),[p]),
 rm:(p,options)=>options?.recursive?fs.rm(p,options):retry(()=>fs.rm(p,options),[p]),
};

export default process.platform==='win32'?new Proxy(fs,{get:(target,key)=>Object.hasOwn(mutators,key)?mutators[key]:target[key]}):fs;
