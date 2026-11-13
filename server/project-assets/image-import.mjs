import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {imagePreviewCache,previewSourceLimit} from './image-preview.mjs';
import {fault,idOK,canonical} from './model.mjs';
import {projectFolderName} from '../prompt-codex/pictures.mjs';
import {privateDirectory} from '../prompt-codex/media.mjs';
import {indexFileIdentity} from '../fs-identity.mjs';

const identity=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
const mimeFor=file=>({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',avif:'image/avif',bmp:'image/bmp'})[path.extname(file).slice(1).toLowerCase()];
async function checkedFile(file){
  const before=await fs.lstat(file);
  if(!before.isFile()||before.isSymbolicLink()||await fs.realpath(file)!==file)throw fault('图片文件或路径已变化',409);
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{if(identity(before)!==identity(await handle.stat()))throw fault('图片正在变化，请重新选择',409);return{handle,before};}catch(e){await handle.close();throw e;}
}
async function unchanged(file,handle,before){
  if(identity(await handle.stat())!==identity(before)||identity(await fs.lstat(file))!==identity(before)||await fs.realpath(file)!==file)throw fault('图片正在变化，请重新选择',409);
}
export async function imageDigest(file,{signal,maxBytes=Infinity}={}){
  const {handle,before}=await checkedFile(file);
  try{if(before.size>maxBytes)throw fault('该图暂不支持自动框选',415);const h=createHash('sha256');let size=0;for await(const chunk of handle.createReadStream({autoClose:false,signal})){size+=chunk.length;if(size>before.size)throw fault('图片正在变化，请重新选择',409);h.update(chunk);}signal?.throwIfAborted();await unchanged(file,handle,before);return{hash:h.digest('hex'),stat:before};}finally{await handle.close();}
}
// Pass an immutable, private snapshot to the decoder. For HEIC use the
// same oriented JPEG conversion as the browser reference preview.
export async function withHeadImage(file,expected,limit,signal,use){
  const compatible=/\.(heic|heif)$/i.test(file),{handle,before}=await checkedFile(file);
  let dir,snapshot,release;
  try{
    if(before.size>limit||(!compatible&&!mimeFor(file)))throw fault('该图暂不支持自动框选',415);
    if(compatible)release=imagePreviewCache.acquire();
    signal.throwIfAborted();
    dir=await fs.mkdtemp(path.join(os.tmpdir(),'shiguang-head-box-'));
    dir=await fs.realpath(dir);
    const input=path.join(dir,'input'+path.extname(file).toLowerCase());
    snapshot=await fs.open(input,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    const h=createHash('sha256');let size=0;
    for await(const chunk of handle.createReadStream({autoClose:false,signal})){
      size+=chunk.length;if(size>before.size)throw fault('图片正在变化，请重新选择',409);
      h.update(chunk);await snapshot.writeFile(chunk);
    }
    const hash=h.digest('hex');
    if(size!==before.size||hash!==expected)throw fault('引用失效：图片内容已变更',409);
    await unchanged(file,handle,before);await snapshot.close();snapshot=null;
    let decodePath=input;
    if(compatible){
      const output=path.join(dir,'preview.jpg');
      const out=await fs.open(output,'wx',0o600);await out.close();
      const key=createHash('sha256').update(file+'|'+identity(before)+'|'+hash).digest('hex');
      const bytes=await imagePreviewCache.preview(input,output,key,{signal});
      decodePath=path.join(dir,'decoded.jpg');await fs.writeFile(decodePath,bytes,{flag:'wx',mode:0o600});
    }
    signal.throwIfAborted();
    const result=await use(decodePath);
    // Cleanup can yield to a replacement at the original path. Hold the
    // original descriptor until cleanup completes, and verify after that wait.
    await fs.rm(dir,{recursive:true,force:true});
    dir=null;
    signal.throwIfAborted();
    await unchanged(file,handle,before);
    await handle.close();
    if(await fs.realpath(file)!==file||identity(await fs.lstat(file))!==identity(before))
      throw fault('图片正在变化，请重新选择',409);
    return result;
  }finally{
    try{
      await Promise.allSettled([handle.close(),snapshot?.close()]);
      if(dir)await fs.rm(dir,{recursive:true,force:true});
    }finally{release?.();}
  }
}

// Verify from the same descriptor that is streamed. Never read the whole image into memory.
export async function streamImage(file,expected,res,{media,verifySource}={}){
  const compatible=/\.(heic|heif)$/i.test(file),controller=new AbortController(),signal=controller.signal;
  const abort=()=>{if(!res.writableFinished)controller.abort();};
  res.once('close',abort);if(res.destroyed)abort();
  let handle,before,snapshot,temp,retained,output,release;
  try{
    signal.throwIfAborted();if(compatible)release=imagePreviewCache.acquire();
    ({handle,before}=await checkedFile(file));
    const mime=compatible?'image/jpeg':mimeFor(file);if(!mime)throw fault('此格式暂不能在浏览器预览，原文件仍保留，可在访达中打开',415);
    if(compatible&&before.size>previewSourceLimit)throw fault('HEIC 原图过大，暂不能生成预览；原文件仍保留，可在访达中打开',413);
    temp=await fs.mkdtemp(path.join(os.tmpdir(),'shiguang-reference-preview-'));
    temp=await fs.realpath(temp);
    retained=path.join(temp,compatible?'snapshot.heic':'snapshot');snapshot=await fs.open(retained,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    // POSIX anonymous inode: later changes to the source cannot change delivered bytes.
    if(!compatible)try{await fs.unlink(retained);retained=null;}catch(e){if(!['EPERM','EACCES','EBUSY'].includes(e.code))throw e;}
    const hash=createHash('sha256');let size=0;
    for await(const chunk of handle.createReadStream({autoClose:false})){signal.throwIfAborted();size+=chunk.length;if(size>before.size)throw fault('图片正在变化，请重新选择',409);hash.update(chunk);await snapshot.writeFile(chunk);}
    const digest=hash.digest('hex');
    if(size!==before.size||expected&&digest!==expected)throw fault('引用失效：图片内容已变更',409);
    await unchanged(file,handle,before);
    let bytes;
    if(compatible){
      output=path.join(temp,'preview.jpg');const created=await fs.open(output,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await created.close();
      const key=createHash('sha256').update(file+'|'+identity(before)+'|'+digest).digest('hex');
      bytes=await imagePreviewCache.preview(retained,output,key,{signal,media});
      await unchanged(file,handle,before);
    }
    await verifySource?.();signal.throwIfAborted();
    res.set({'Content-Type':mime,'Content-Length':String(bytes?.length??before.size),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'"});
    await pipeline(bytes?Readable.from([bytes]):snapshot.createReadStream({autoClose:false,start:0}),res,{signal});
  }finally{
    res.removeListener('close',abort);
    try{await handle?.close();}finally{try{await snapshot?.close();}finally{
      if(output)await fs.unlink(output).catch(()=>{});if(retained)await fs.unlink(retained).catch(()=>{});if(temp)await fs.rmdir(temp).catch(()=>{});release?.();
    }}
  }
}

async function publishRelative(s,suffixed){
  const metadata={directory:{dev:s.state.targetIdentity.dev,ino:s.state.targetIdentity.ino},stage:s.stage,stageIdentity:identity(s.stageStat),fileName:s.fileName,suffixed};
  const child=spawn(process.execPath,[path.join(import.meta.dirname,'image-publish-worker.mjs'),JSON.stringify(metadata)],{cwd:s.state.target,env:{PATH:process.env.PATH||''},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',spawnError;
  child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',e=>spawnError=e);
  const result=await new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
  if(spawnError||result.code!==0||result.signal)throw fault(stderr||'图片保存进程未正常完成，文件已保留，请核对后重试',409);
  let parsed;try{parsed=JSON.parse(stdout);}catch{throw fault('图片保存结果未能确认，请核对项目文件夹',409);}
  if(typeof parsed.fileName!=='string'||path.basename(parsed.fileName)!==parsed.fileName)throw fault('图片保存结果无效',409);
  return parsed.fileName;
}

export class ReferenceImageImports{
  constructor(store,pictures){this.store=store;this.lib=store.lib;this.pictures=pictures;this.sessions=new Map();this.hashCache=new Map();}
  guard(s){
    this.pictures.writable();
    const { assetId, projectId, lookId, seriesId, contextToken } = s.target;
    let a;
    if (seriesId) {
      const scope = this.store.scoped.scope(s.scopeType, projectId);
      this.store.scoped.assertContextToken(scope, contextToken);
      const item = this.store.scoped.detailInTransaction(scope, assetId);
      if (item.owner.type !== 'series' || item.owner.id !== seriesId || item.asset.archived_at) {
        throw fault('原资产归属已变化，请重新选择', 409, { code: 'ASSET_SCOPE_CHANGED' });
      }
      a = item.asset;
      if (a.kind === 'character' ? !a.looks.some(look => look.id === lookId && look.archived_at === null) : lookId !== null) {
        throw fault('请选择已保存的当前造型或资产', 409, { code: 'ASSET_SCOPE_CHANGED' });
      }
      if (s.scopeType === 'episode') this.store.generationLocks?.assertWritable(projectId);
      return a;
    }
    a = this.store.get(assetId);
    this.store.project(a.project_id);
    if(a.project_id!==projectId||a.archived_at)throw fault('原资产已归档或所属项目已变化，文件不绑定到其他资料',409);
    if(a.kind==='character'){
      const l=a.looks.find(l=>l.id===s.target.lookId);
      const owner=this.store.db.prepare('SELECT asset_id FROM creative_looks WHERE id=?').get(s.target.lookId);
      if(l?.archived_at||owner&&owner.asset_id!==a.id)throw fault('原造型已变化，请核对后重新选择',409);
    }
    this.store.generationLocks?.assertWritable(a.project_id);return a;
  }
  get(id){const s=this.sessions.get(id);if(!s)throw fault('导入记录已过期或服务已重启；已完成的图片仍在项目文件夹，请从素材库选择',404);this.guard(s);return s;}
  dto(s){const {contextToken,...target}=s.target;return{id:s.id,status:s.status,target,fileName:s.finalName||s.fileName,mediaAssetId:s.mediaId,previewUrl:s.mediaId?'/api/project-assets/media/'+s.mediaId+'/preview':null,candidates:(s.candidates||[]).map(c=>({id:c.id,name:path.basename(c.file),reason:c.reason,previewUrl:'/api/project-assets/image-imports/'+s.id+'/candidates/'+c.id+'/preview'})),error:s.error};}
  async start(input){
    const {requestId,assetId,projectId,lookId=null,fileName,bytes,append_context_token,series_context_token}=input;
    if(!idOK(requestId)||!idOK(assetId)||!idOK(projectId)||lookId!==null&&!idOK(lookId)||typeof fileName!=='string'||!fileName||/^[. ]|[<>:"/\\|?*\x00-\x1f]|[. ]$/.test(fileName)||!Number.isSafeInteger(bytes)||bytes<1)throw fault('请选择一张有效的本地图片；文件名不能包含路径或系统保留字符');
    const target={assetId,projectId,lookId};
    let scopeType;
    if (append_context_token !== undefined || series_context_token !== undefined) {
      if (append_context_token !== undefined && series_context_token !== undefined) throw fault('请选择一个明确的图片导入目标', 422);
      scopeType = append_context_token === undefined ? 'series' : 'episode';
      const scope = this.store.scoped.scope(scopeType, projectId);
      this.store.scoped.assertContextToken(scope, append_context_token ?? series_context_token);
      if (!scope.series_id) throw fault('当前项目未归入剧，请重新选择', 409, { code: 'ASSET_SCOPE_CHANGED' });
      Object.assign(target, { seriesId: scope.series_id, contextToken: scope.context_token });
    }
    const args=canonical({target,fileName,bytes});
    const previous=this.sessions.get(requestId);if(previous){if(previous.args!==args)throw fault('导入编号已用于其他文件',409);this.guard(previous);return this.dto(previous);}
    const s={id:requestId,target,scopeType,fileName,bytes,args,status:'preparing',created:Date.now()};const a=this.guard(s);
    if(a.kind==='character'?!lookId:lookId!==null)throw fault('请选择当前造型');
    // Reserve the ID before the first asynchronous filesystem operation.
    this.sessions.set(s.id,s);s.running=true;
    try{await this.pictures.serial(async()=>{
      const state=await this.pictures.prepare();await this.pictures.current(state);
      const p=s.target.seriesId?this.lib.projectSeries.series(s.target.seriesId):this.store.project(projectId);
      const scope={id:p.id,name:p.project_kind==='public'?'公共人物库':p.name};
      const existing=(await fs.readdir(this.pictures.directory,{withFileTypes:true})).filter(e=>e.name.endsWith('--'+scope.id.toLowerCase()));
      if(existing.length>1)throw fault('同一项目存在多个图片文件夹，请核对后再导入',409);
      const target=path.join(this.pictures.directory,existing[0]?.name||projectFolderName(scope));await privateDirectory(target);
      Object.assign(state,{target,targetIdentity:await fs.lstat(target)});await this.pictures.current(state);this.guard(s);s.state=state;
    });s.status='waiting';}catch(e){s.status='failed';s.error=e.message;throw e;}finally{s.running=false;}
    // Bounded receipt metadata only; originals and completed copies are never expired here.
    for(const [id,row]of this.sessions)if(Date.now()-row.created>86400000&&!row.running)this.sessions.delete(id);
    this.sessions.set(s.id,s);return this.dto(s);
  }
  async cachedDigest(file){
    const st=await fs.lstat(file),key=file+'|'+identity(st);
    if(st.isSymbolicLink()||!st.isFile()||await fs.realpath(file)!==file)throw fault('已有图片路径已变化',409);
    if(this.hashCache.has(key))return{hash:this.hashCache.get(key),stat:st};
    const result=await imageDigest(file);if(this.hashCache.size>2000)this.hashCache.clear();this.hashCache.set(key,result.hash);return result;
  }
  async upload(id,stream){
    const s=this.get(id);if(s.status!=='waiting'||s.running)throw fault('该文件已接收或正在接收，请核对导入结果，不能重复发送',409);
    s.running=true;s.status='uploading';let handle;
    try{
      await this.pictures.current(s.state);this.guard(s);
      s.cache=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'shiguang-reference-import-')));s.stage=path.join(s.cache,'original.partial');handle=await fs.open(s.stage,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      await this.pictures.current(s.state);this.guard(s);s.stageInode=await handle.stat();
      let size=0;const hash=createHash('sha256');
      for await(const chunk of stream){size+=chunk.length;if(size>s.bytes)throw fault('文件长度与所选原图不一致',409);await this.pictures.current(s.state);this.guard(s);await handle.writeFile(chunk);hash.update(chunk);}
      if(size!==s.bytes)throw fault('图片没有完整接收，请保留输入后重新选择',409);
      await handle.sync();await handle.close();handle=null;s.hash=hash.digest('hex');s.stageStat=await fs.lstat(s.stage);
      return await this.pictures.serial(async()=>{
        await this.pictures.current(s.state);this.guard(s);s.candidates=[];
        for(const e of await fs.readdir(s.state.target,{withFileTypes:true})){
          if(!e.isFile()||e.name.startsWith('.'))continue;
          const file=path.join(s.state.target,e.name),st=await fs.lstat(file),sameName=e.name.normalize('NFC').toLowerCase()===s.fileName.normalize('NFC').toLowerCase();
          if(!sameName&&st.size!==s.bytes)continue;
          const d=await this.cachedDigest(file);if(sameName||d.hash===s.hash)s.candidates.push({id:randomUUID(),file,hash:d.hash,stat:d.stat,reason:sameName?'同名图片':'相同内容'});
        }
        if(s.candidates.length){s.status='duplicate';return this.dto(s);}
        return this.publish(s,false);
      });
    }catch(e){const detail={ENOSPC:'磁盘空间不足',EACCES:'没有文件夹写入权限',EPERM:'无法访问此文件夹',ENAMETOOLONG:'图片文件名过长，请缩短文件名后重试',EXDEV:'文件夹所在磁盘不支持此保存操作'}[e.code];s.status='failed';s.error=e.status?e.message:(detail||'图片导入未完成')+'；请保留原图，已完成的文件不会删除';throw e.status?e:fault(s.error,409);}finally{await handle?.close();s.running=false;}
  }
  async resolve(id,input){
    const s=this.get(id);if(s.status==='ready')return this.dto(s);
    if(s.status!=='duplicate'||s.running)throw fault('请先完整接收图片并核对重复项',409);
    s.running=true;
    try{return await this.pictures.serial(async()=>{
      await this.pictures.current(s.state);this.guard(s);
      if(input.choice==='import')return this.publish(s,true);
      if(input.choice!=='reuse')throw fault('请选择使用原图或继续导入');
      const c=s.candidates.find(c=>c.id===input.candidateId);if(!c)throw fault('请选择本次提示中的原图');
      const d=await imageDigest(c.file);if(d.hash!==c.hash||identity(d.stat)!==identity(c.stat))throw fault('原图已变化，请重新导入并核对',409);
      return this.register(s,c.file,d);
    });}finally{s.running=false;}
  }
  async publish(s,suffixed){
    await this.pictures.current(s.state);this.guard(s);
    if(identity(await fs.lstat(s.stage))!==identity(s.stageStat))throw fault('待导入图片已变化',409);
    const lock='reference-import:'+s.id;this.lib.locks.add(lock);
    try{s.published=path.join(s.state.target,await publishRelative(s,suffixed));
      await this.pictures.current(s.state);const d=await imageDigest(s.published);
      if(d.hash!==s.hash)throw fault('导入文件校验失败，文件已保留但未加入资料',409);
      return await this.register(s,s.published,d);
    }finally{this.lib.locks.delete(lock);}
  }
  async register(s,file,d){
    await this.pictures.current(s.state);this.guard(s);const current=await fs.lstat(file);
    if(identity(current)!==identity(d.stat))throw fault('图片已变化，未登记到资料',409);
    const db=this.lib.db,old=db.prepare('SELECT * FROM assets WHERE path=?').get(file);
    if(old&&(old.trashed||old.kind!=='photo'||old.root_id!==s.state.root.id))throw fault('已有素材记录状态不同，请核对素材库；文件已保留',409);
    const mediaId=old?.id||randomUUID();
    if(!old){const ids=indexFileIdentity(current);db.prepare('INSERT INTO assets(id,root_id,path,name,ext,kind,size,mtime,created_ms,category,sub,basis,review,dev,ino,sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(mediaId,s.state.root.id,file,path.basename(file),path.extname(file).slice(1).toLowerCase(),'photo',current.size,current.mtimeMs,current.birthtimeMs||current.mtimeMs,'','','参考图片导入',0,ids.dev,ids.ino,d.hash);}
    this.lib.directoryClassification?.sync(s.state.root.id,mediaId);
    s.mediaId=mediaId;s.finalName=path.basename(file);s.status='ready';s.error=null;
    // No pathname-based deletion: completed files and private receive caches are retained.
    return this.dto(s);
  }
  async cancel(id){
    const s=this.get(id);if(s.running)throw fault('图片仍在接收或保存，请稍后核对结果',409);
    if(s.status==='ready')return this.dto(s);
    // A user may have moved/replaced any file; cancellation never unlinks a pathname.
    s.status='cancelled';s.error=null;
    return this.dto(s);
  }
  async preview(id,candidateId,res){const s=this.get(id);await this.pictures.current(s.state);const c=s.candidates?.find(c=>c.id===candidateId);if(!c)throw fault('重复图片不存在',404);await streamImage(c.file,c.hash,res);}
}
