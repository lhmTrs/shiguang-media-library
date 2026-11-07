import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {fault} from '../prompt-templates/model.mjs';

export const MAX_IMAGE_BYTES=20*1024*1024;
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const validId=id=>typeof id==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id);
export function imageFormat(bytes) {
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>MAX_IMAGE_BYTES)throw fault('图片为空或超过 20 MB');
  if(bytes.length>24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){
    const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);if(!width||!height||width*height>100_000_000)throw fault('图片尺寸超出限制');return{mime:'image/png',ext:'png'};
  }
  if(bytes.length>3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return{mime:'image/jpeg',ext:'jpg'};
  if(bytes.length>12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return{mime:'image/webp',ext:'webp'};
  if(bytes.length>10&&['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6)))return{mime:'image/gif',ext:'gif'};
  throw fault('仅支持 PNG、JPEG、WebP、GIF 图片');
}
export function decodeImage(value) {
  if(typeof value!=='string'||value.length>MAX_IMAGE_BYTES*1.4)throw fault('未收到可保存的图片数据');
  const raw=value.replace(/^data:image\/(?:png|jpeg|webp|gif);base64,/,'');
  if(!/^[A-Za-z0-9+/]*={0,2}$/.test(raw)||raw.length%4===1)throw fault('图片编码无效');
  const bytes=Buffer.from(raw,'base64');imageFormat(bytes);return bytes;
}
export async function privateDirectory(directory) {
  await fs.mkdir(directory,{recursive:true,mode:0o700});
  const stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw fault('图片存储目录无效');
  return fs.realpath(directory);
}
export class CodexMedia {
  constructor(dataDir,{generatedDirectory=path.join(process.env.CODEX_HOME||path.join(os.homedir(),'.codex'),'generated_images')}={}) {this.base=path.join(dataDir,'prompt-codex');this.directory=path.join(this.base,'images');this.work=path.join(this.base,'work');this.generatedDirectory=path.resolve(generatedDirectory);}
  async init(){await privateDirectory(this.base);await privateDirectory(this.directory);await privateDirectory(this.work);return this;}
  async scratch(id){if(!validId(id))throw fault('任务 ID 无效');return privateDirectory(path.join(this.work,id));}
  async readScratch(file,scratch){
    if(typeof file!=='string')throw fault('未提供图片文件');
    const absolute=path.resolve(scratch,file),real=await fs.realpath(absolute),root=await fs.realpath(scratch);
    if(!real.startsWith(root+path.sep)||(await fs.lstat(absolute)).isSymbolicLink())throw fault('图片文件不在当前任务目录');
    return this.readBounded(real);
  }
  async readBounded(file){
    const before=await fs.lstat(file);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>MAX_IMAGE_BYTES)throw fault('图片文件过大或无效');
    const same=s=>s.dev===before.dev&&s.ino===before.ino&&s.size===before.size&&s.mtimeMs===before.mtimeMs&&s.ctimeMs===before.ctimeMs;
    const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{if(!same(await handle.stat()))throw fault('图片文件已变化，请重新核对');const bytes=Buffer.alloc(before.size);let read=0;while(read<bytes.length){const result=await handle.read(bytes,read,bytes.length-read,read);if(!result.bytesRead)throw fault('图片文件不完整');read+=result.bytesRead;}if(!same(await handle.stat())||!same(await fs.lstat(file)))throw fault('图片文件已变化，请重新核对');imageFormat(bytes);return bytes;}finally{await handle.close();}
  }
  async receive(item,{scratch,threadId}){
    if(item.savedPath){const absolute=path.resolve(scratch,item.savedPath);if(absolute.startsWith(path.resolve(scratch)+path.sep))return this.readScratch(absolute,scratch);return this.readGenerated(absolute,threadId,item.id);}
    if(typeof item.result==='string')return decodeImage(item.result);
    if(typeof item.fileId==='string'&&item.fileId)return this.readGenerated(path.join(this.generatedDirectory,String(threadId),String(item.id)+'.png'),threadId,item.id);
    throw fault('生成结果未提供原图文件或图片数据');
  }
  async readGenerated(file,threadId,itemId){
    const component=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,179}$/.test(value);
    if(!component(threadId)||!component(itemId))throw fault('生成图片的会话或任务标识无效');
    const expected=path.join(this.generatedDirectory,threadId),extension=path.extname(file).slice(1);
    if(!['png','jpg','jpeg','webp','gif'].includes(extension)||path.basename(file)!==itemId+'.'+extension)throw fault('图片文件与本次生成任务不匹配');
    const root=await fs.realpath(this.generatedDirectory),canonical=path.join(root,threadId,path.basename(file));
    if(![expected,path.join(root,threadId)].includes(path.dirname(file)))throw fault('图片文件与本次生成任务不匹配');
    if((await fs.lstat(this.generatedDirectory)).isSymbolicLink()||(await fs.lstat(expected)).isSymbolicLink()||await fs.realpath(file)!==canonical)throw fault('生成图片目录不能使用符号链接');
    return this.readBounded(canonical);
  }
  file(row){if(!validId(row.id)||row.file_name!==row.id+'.'+({ 'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif'}[row.mime]))throw fault('图片记录格式无效');return path.join(this.directory,row.file_name);}
  async read(row){const file=this.file(row),st=await fs.lstat(file);if(st.isSymbolicLink()||!st.isFile()||st.size!==row.bytes||st.size>MAX_IMAGE_BYTES)throw fault('图片文件缺失或已变化',409);const bytes=await fs.readFile(file);if(sha256(bytes)!==row.sha256)throw fault('图片校验失败',409);return bytes;}
  async save(bytes,turnId){const type=imageFormat(bytes),id=randomUUID(),now=Date.now();const row={id,turn_id:turnId,file_name:id+'.'+type.ext,sha256:sha256(bytes),mime:type.mime,bytes:bytes.length,created_at:now,updated_at:now};await fs.writeFile(this.file(row),bytes,{flag:'wx',mode:0o600});return row;}
  async install(row,bytes){imageFormat(bytes);const file=this.file(row);try{await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});return true;}catch(e){if(e.code!=='EEXIST')throw e;if(!Buffer.from(await this.read(row)).equals(bytes))throw fault('现有图片内容冲突，未覆盖',409);return false;}}
}
