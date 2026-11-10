import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {PHOTO,VIDEO,AUDIO} from '../fs-identity.mjs';

export const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
export const stamp = s => ({dev:String(s.dev),ino:String(s.ino),size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs});
export const same = (a,b) => !!a && !!b && Object.keys(stampKeys).every(k => a[k] === b[k]);
const stampKeys = {dev:1,ino:1,size:1,mtimeMs:1,ctimeMs:1};
export function error(code, message, status=409) {return Object.assign(new Error(message),{code,status});}

export async function privateDirectory(dir) {
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  const st = await fs.lstat(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid()) || (process.platform !== 'win32' && (st.mode & 0o077)))
    throw error('INTAKE_PRIVATE_DIRECTORY','文件任务目录必须属于当前用户，且仅当前用户可访问');
  return fs.realpath(dir);
}

// Only the native CLI calls this with paths. HTTP callers can select opaque IDs,
// never supply a path to be read, moved or deleted.
export async function inspectSelection(files) {
  // Keep the legacy error code for existing callers; the accepted types expand.
  if (!Array.isArray(files) || !files.length || files.some(p => typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')))
    throw error('INTAKE_VIDEO_ONLY','请在访达选择一个或多个照片、视频或音频文件');
  const result = [];
  for (const file of [...new Set(files)]) {
    const st = await fs.lstat(file), ext=path.extname(file).slice(1).toLowerCase();
    const mediaKind=PHOTO.has(ext)?'photo':VIDEO.has(ext)?'video':AUDIO.has(ext)?'audio':null;
    if (!st.isFile() || st.isSymbolicLink() || !mediaKind || st.size < 1)
      throw error('INTAKE_VIDEO_ONLY','只能收纳照片、视频或音频；选择中含不支持的文件、空文件、文件夹或链接时，整批不会开始导入');
    const real = await fs.realpath(file);
    const parent=await fs.lstat(path.dirname(real));
    result.push({id:randomUUID(),path:real,name:path.basename(real),mediaKind,bytes:st.size,identity:stamp(st),
      parentIdentity:{dev:String(parent.dev),ino:String(parent.ino)}});
  }
  return result;
}

export async function unchanged(file, identity) {
  const st = await fs.lstat(file);
  if (!st.isFile() || st.isSymbolicLink() || await fs.realpath(file) !== file || !same(stamp(st),identity))
    throw error('INTAKE_SOURCE_CHANGED','原文件在选择后发生变化，未移除原文件；请重新选择');
}

async function parentUnchanged(file) {
  const st=await fs.lstat(path.dirname(file.path));
  if(!st.isDirectory()||st.isSymbolicLink()||String(st.dev)!==file.parentIdentity?.dev||String(st.ino)!==file.parentIdentity?.ino)
    throw error('INTAKE_SOURCE_CHANGED','原文件夹在选择后发生变化，原件保留；请重新选择');
}

// A selection proof is made once, from one held descriptor, before it may be
// used to distinguish later metadata-only changes from changed source bytes.
export async function selectionHash(file,{signal}={}) {
  signal?.throwIfAborted();
  await unchanged(file.path,file.identity);await parentUnchanged(file);
  const handle=await fs.open(file.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try {
    if(!same(stamp(await handle.stat()),file.identity))throw error('INTAKE_SOURCE_CHANGED','原文件已变化');
    const hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let bytes=0;
    while(true){signal?.throwIfAborted();const {bytesRead}=await handle.read(buffer,0,buffer.length,bytes);if(!bytesRead)break;if(bytes+bytesRead>file.bytes)throw error('INTAKE_SOURCE_CHANGED','核验期间原文件长度变化，请重新选择');hash.update(buffer.subarray(0,bytesRead));bytes+=bytesRead;}
    if(bytes!==file.bytes||!same(stamp(await handle.stat()),file.identity))throw error('INTAKE_SOURCE_CHANGED','核验期间原文件发生变化，请重新选择');
    await unchanged(file.path,file.identity);await parentUnchanged(file);
    return hash.digest('hex');
  } finally {await handle.close();}
}

export async function revalidateSelection(file) {
  await parentUnchanged(file);
  try {await unchanged(file.path,file.identity);return file.identity;}
  catch(e) {if(e.code!=='INTAKE_SOURCE_CHANGED')throw e;}
  const st=await fs.lstat(file.path),identity=stamp(st);
  if(!st.isFile()||st.isSymbolicLink()||!same({...identity,ctimeMs:file.identity.ctimeMs},file.identity)||!/^[a-f0-9]{64}$/.test(file.selectionSha256||''))
    throw error('INTAKE_SOURCE_CHANGED','原文件在选择后发生变化，未移除原文件；请重新选择');
  if(await selectionHash({...file,identity})!==file.selectionSha256)
    throw error('INTAKE_SOURCE_CHANGED','原文件内容在选择后发生变化，原件保留；请重新选择');
  return identity;
}

export class Receipts {
  constructor(dataDir) {this.base=path.join(dataDir,'file-intake');}
  async init() {
    this.base=await privateDirectory(this.base);
    for (const kind of ['handoffs','batches']) await privateDirectory(path.join(this.base,kind));
    return this;
  }
  file(kind,id) {
    if (!['handoffs','batches'].includes(kind) || !uuid(id)) throw error('INTAKE_NOT_FOUND','文件任务不存在',404);
    return path.join(this.base,kind,id+'.json');
  }
  async read(kind,id) {
    const file=this.file(kind,id), h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try {
      const st=await h.stat();
      if (!st.isFile() || (process.getuid && st.uid !== process.getuid()) || (process.platform !== 'win32' && (st.mode & 0o077)) || st.size>8*1024*1024)
        throw error('INTAKE_RECEIPT_INVALID','文件任务回执不可用');
      const value=JSON.parse(await h.readFile('utf8'));
      if(!value||typeof value!=='object'||value.id!==id)throw error('INTAKE_RECEIPT_INVALID','文件任务编号与原回执不一致');
      return value;
    } finally {await h.close();}
  }
  async write(kind,id,value,{exclusive=false}={}) {
    const target=this.file(kind,id), temporary=target+'.'+randomUUID()+'.tmp';
    const h=await fs.open(temporary,'wx',0o600);
    try {await h.writeFile(JSON.stringify(value));await h.sync();} finally {await h.close();}
    try {if(exclusive){await fs.link(temporary,target);await fs.unlink(temporary);} else await fs.rename(temporary,target);}
    catch(e){await fs.unlink(temporary).catch(()=>{});throw e;}
    const dir=await fs.open(path.dirname(target),'r');
    try {await dir.sync();} finally {await dir.close();}
  }
  async list(kind,{tolerateInvalid=false}={}) {
    const names=await fs.readdir(path.join(this.base,kind)), result=[];
    for(const name of names) if (name.endsWith('.json') && uuid(name.slice(0,-5))) {
      try{result.push(await this.read(kind,name.slice(0,-5)));}
      catch(e){if(!tolerateInvalid)throw e;result.push({id:name.slice(0,-5),invalid:true,error:'文件任务回执不可读，原文件未操作；请保留原回执核对'});}
    }
    return result;
  }
  async handoff(files,{deferFingerprint=false}={}) {
    const id=randomUUID(), value={id,createdAt:Date.now(),preparation:'checking',files:await inspectSelection(files)};
    await this.write('handoffs',id,value,{exclusive:true});
    return deferFingerprint?value:this.prepareHandoff(id);
  }
  async prepareHandoff(id,{signal}={}) {
    const value=await this.read('handoffs',id);
    if(value.preparation!=='checking')return value;
    try {
      for(const file of value.files)file.selectionSha256=await selectionHash(file,{signal});
      value.preparation='ready';await this.write('handoffs',id,value);return value;
    } catch(e) {
      value.preparation='failed';value.preparationError='原文件核验未完成，未开始收纳；请从访达重新选择。';
      await this.write('handoffs',id,value);throw e;
    }
  }
}
