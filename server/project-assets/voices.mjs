import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {fault,idOK,voiceProfile,VOICE_KEY,VOICE_LIMIT,VOICE_TYPES,canonical} from './model.mjs';

const identity=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs,s.nlink].join(':');
const hash=b=>createHash('sha256').update(b).digest('hex');
function audio(bytes,ext){
  const starts=s=>bytes.subarray(0,s.length).toString('latin1')===s;
  const ok=ext==='wav'?starts('RIFF')&&bytes.subarray(8,12).toString()==='WAVE':ext==='flac'?starts('fLaC'):ext==='ogg'?starts('OggS'):ext==='m4a'?bytes.subarray(4,8).toString()==='ftyp':ext==='aac'?bytes[0]===255&&(bytes[1]&246)===240:starts('ID3')||bytes[0]===255&&(bytes[1]&224)===224;
  if(bytes.length<12||!ok)throw fault('文件内容与语音格式不符，请添加有效的音频文件');
}

// Files are immutable local copies. Bindings live in the existing versioned
// character details, so old revisions and copied characters keep their audio.
export class CharacterVoiceFiles {
  constructor(lib){this.lib=lib;this.root=null;this.pins=new Map();this.initializing=null;this.receipts=new Map();}
  async directory(dir,create=false){
    if(create)await fs.mkdir(dir,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
    const s=await fs.lstat(dir),key=[s.dev,s.ino].join(':');
    if(!s.isDirectory()||s.isSymbolicLink()||await fs.realpath(dir)!==dir||this.pins.has(dir)&&this.pins.get(dir)!==key)throw fault('角色语音目录已变化，请保留资料并重新核对',409);
    this.pins.set(dir,key);
  }
  async init(){
    if(!this.initializing)this.initializing=(async()=>{const base=await fs.realpath(this.lib.dataDir);this.root=path.join(base,'character-voices');await this.directory(this.root,true);})().catch(e=>{this.initializing=null;throw e;});
    await this.initializing;await this.directory(this.root);
  }
  async location(id,create=false){if(!idOK(id))throw fault('角色语音编号无效');await this.init();const dir=path.join(this.root,id);await this.directory(dir,create);await this.directory(this.root);return dir;}
  async write(id,name,bytes){
    const dir=await this.location(id),file=path.join(dir,name);
    const handle=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try{
      // Inspect the opened file and every pinned parent before writing content.
      // Never let writeFile follow a substituted parent with the audio payload.
      await this.directory(this.root);await this.directory(dir);
      const before=await handle.stat(),atPath=await fs.lstat(file);
      if(!before.isFile()||before.nlink!==1||before.size!==0||identity(before)!==identity(atPath))throw fault('角色语音写入位置已变化',409);
      await handle.writeFile(bytes);await handle.sync();
      await this.directory(this.root);await this.directory(dir);
      if(identity(await handle.stat())!==identity(await fs.lstat(file)))throw fault('角色语音写入位置已变化',409);
    }finally{await handle.close();}
  }
  async read(id,name,max){
    const dir=await this.location(id),file=path.join(dir,name);await this.directory(dir);
    const before=await fs.lstat(file);
    if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>max)throw fault('角色语音副本状态无效',409);
    const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      await this.directory(this.root);await this.directory(dir);
      if(identity(before)!==identity(await handle.stat()))throw fault('角色语音副本已变化',409);
      const buffer=Buffer.alloc(before.size+1),{bytesRead}=await handle.read(buffer,0,buffer.length,0);
      await this.directory(this.root);await this.directory(dir);
      if(bytesRead!==before.size||identity(before)!==identity(await handle.stat())||identity(before)!==identity(await fs.lstat(file)))throw fault('角色语音副本读取时发生变化',409);
      return buffer.subarray(0,bytesRead);
    }finally{await handle.close();}
  }
  async metadata(id){const m=JSON.parse((await this.read(id,'metadata.json',4096)).toString('utf8'));const clip=voiceProfile(canonical({version:1,description:'',clip:m.clip})).clip;if(clip.id!==id||!idOK(m.owner)||Object.keys(m).sort().join(',')!=='clip,owner')throw fault('角色语音副本记录损坏',409);return {owner:m.owner,clip};}
  pending(asset,clip,metadata){
    const issued=this.receipts.get(clip.id);
    if(!issued||issued.owner!==asset.id||canonical(issued.clip)!==canonical(clip)||canonical(issued)!==canonical(metadata))throw fault('语音未保存的上传回执已失效或归属不符，请重新添加',409);
  }
  async upload(asset,input,guard){
    if(asset.kind!=='character'||asset.archived_at)throw fault('请先选择未归档的人物再添加语音');
    if(!input||Object.keys(input).some(k=>!['name','base64','expected_revision'].includes(k))||typeof input.name!=='string')throw fault('角色语音上传参数无效');
    const ext=path.extname(input.name).slice(1).toLowerCase();
    if(!Object.hasOwn(VOICE_TYPES,ext)||!input.name.trim()||input.name.length>240||/[\x00-\x1f\x7f/\\]/.test(input.name))throw fault('支持 MP3、WAV、M4A、AAC、OGG、FLAC 语音文件');
    if(typeof input.base64!=='string'||input.base64.length>Math.ceil(VOICE_LIMIT/3)*4||!input.base64.length||input.base64.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64))throw fault('语音文件无效或超过10 MiB');
    const bytes=Buffer.from(input.base64,'base64');if(!bytes.length||bytes.length>VOICE_LIMIT||bytes.toString('base64')!==input.base64)throw fault('语音文件无效或超过10 MiB');audio(bytes,ext);guard();
    if(this.receipts.size>=512)throw fault('本次运行的语音上传已达上限，请先保存资料后重新打开素材服务',409);
    const id=randomUUID(),clip={id,name:input.name,bytes:bytes.length,ext,mime:VOICE_TYPES[ext],sha256:hash(bytes)},dir=await this.location(id,true);
    await this.write(id,'clip.'+ext,bytes);guard();
    const receipt={owner:asset.id,clip};await this.write(id,'metadata.json',canonical(receipt));guard();this.receipts.set(id,structuredClone(receipt));
    return clip;
  }
  async prepare(asset,previous){
    const p=voiceProfile(asset.details[VOICE_KEY]),old=voiceProfile(previous?.details?.[VOICE_KEY]);
    if(previous?.archived_at&&canonical(p)!==canonical(old))throw fault('归档人物的角色语音只读，请先恢复人物',409);
    if(p.clip&&canonical(p.clip)!==canonical(old.clip)){
      const m=await this.metadata(p.clip.id);
      this.pending(asset,p.clip,m);
      await this.bytes(m.clip);
    }
  }
  async bytes(clip){const bytes=await this.read(clip.id,'clip.'+clip.ext,VOICE_LIMIT);if(bytes.length!==clip.bytes||hash(bytes)!==clip.sha256)throw fault('角色语音副本内容已变化，请重新添加',409);return bytes;}
  async preview(asset,id){
    const p=voiceProfile(asset.details[VOICE_KEY]),m=await this.metadata(id);
    if(p.clip?.id!==id){if(m.owner!==asset.id)throw fault('此语音不属于当前人物',404);this.pending(asset,m.clip,m);}
    if(p.clip?.id===id&&canonical(p.clip)!==canonical(m.clip))throw fault('角色语音记录与副本不一致',409);
    return {bytes:await this.bytes(m.clip),mime:m.clip.mime};
  }
}
