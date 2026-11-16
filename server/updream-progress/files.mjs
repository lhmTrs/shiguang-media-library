import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
export const failure=code=>Object.assign(Error(code),{code});
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
export async function directory(file,{privateMode=false}={}){
 const s=await fs.lstat(file);
 if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||privateMode&&(s.mode&0o077)||await fs.realpath(file)!==file)throw failure('unsafe_record');
 return s;
}
export async function readJson(file,{limit=8*1024*1024,budget={left:32*1024*1024},privateMode=false}={}){
 if(!path.isAbsolute(file)||await fs.realpath(path.dirname(file))!==path.dirname(file))throw failure('unsafe_record');
 const parent=await directory(path.dirname(file));
 const h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=await h.stat();
  if(!before.isFile()||before.uid!==process.getuid?.()||privateMode&&(before.mode&0o077))throw failure('unsafe_record');
  if(before.size>limit||before.size>budget.left)throw failure('read_limit');budget.left-=before.size;
  const buffer=Buffer.alloc(before.size+1);let size=0;
  while(size<buffer.length){const r=await h.read(buffer,size,buffer.length-size,size);if(!r.bytesRead)break;size+=r.bytesRead;}
  const after=await h.stat(),current=await fs.lstat(file),parentAfter=await directory(path.dirname(file));
  if(!same(before,after)||!same(before,current)||!same(parent,parentAfter)||current.isSymbolicLink()||before.size!==size||after.size!==size||before.mtimeMs!==after.mtimeMs)throw failure('record_changed');
  let value;try{value=JSON.parse(buffer.subarray(0,size).toString('utf8'));}catch{throw failure('invalid_record');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw failure('invalid_record');
  return {value,mtime:after.mtimeMs};
 }finally{await h.close();}
}
export async function privateFolder(file){
 // Only display preferences may be created, never the producer queue.
 const parent=path.dirname(file);await directory(parent);
 try{await fs.mkdir(file,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
 await directory(file,{privateMode:true});
}
export async function writePrivate(file,value){
 const {randomUUID}=await import('node:crypto');const folder=path.dirname(file);const parent=await directory(folder,{privateMode:true});
 const temp=path.join(folder,'.'+randomUUID()+'.tmp');let h;
 try{
  h=await fs.open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  await h.writeFile(JSON.stringify(value));await h.sync();await h.close();h=null;
  if(!same(parent,await directory(folder,{privateMode:true})))throw failure('unsafe_record');
  try{const old=await fs.lstat(file);if(!old.isFile()||old.isSymbolicLink()||old.uid!==process.getuid?.()||old.mode&0o077)throw failure('unsafe_record');}catch(e){if(e.code!=='ENOENT')throw e;}
  await fs.rename(temp,file);const d=await fs.open(folder,constants.O_RDONLY);try{await d.sync();}finally{await d.close();}
 }finally{await h?.close();await fs.unlink(temp).catch(()=>{});}
}
