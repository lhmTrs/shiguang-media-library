import fs from 'node:fs/promises';
import path from 'node:path';
import {canonical} from '../project-assets/model.mjs';
import {fail} from '../storyboard-video/model.mjs';
import {rootIdentity} from '../fs-identity.mjs';
import {mediaContentFingerprint} from './content-identity.mjs';

export const fileStamp = s => ({dev:String(s.dev),ino:String(s.ino),size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs});
const same = (a,b) => canonical(a) === canonical(b);
const fingerprint = value => value && ({version:value.version,hash:value.hash});

// Authority is frozen before IO and compared again before the short DB write.
// File hashing is deliberately outside the catalog's global mutation queue.
export class ProjectVideoVerification {
  constructor(catalog) { this.catalog=catalog; this.pending=new Map(); this.results=new Map(); }
  get db() { return this.catalog.db; }
  authority(id,sourceId) {
    const c=this.catalog,source=c.videos.source(id,sourceId),meta=c.metadata(id,source);
    return canonical({source,record:meta.row,approvals:[source.id,c.managedKey(source.id)].map(key=>this.db.prepare('SELECT * FROM storyboard_video_approvals WHERE id=? AND project_id=?').get(key,id)),asset:meta.data.mediaAssetId?this.db.prepare('SELECT * FROM assets WHERE id=?').get(meta.data.mediaAssetId):null,roots:c.lib.roots()});
  }
  assertAuthority(s) {
    this.catalog.project(s.projectId);
    if(this.authority(s.projectId,s.source.id)!==s.authority)fail('VIDEO_CONFLICT','核验期间视频资料或读取授权已变化，请重新读取',409);
  }
  async capture(id,sourceId,{allowExternal=false}={}) {
    const c=this.catalog; c.project(id);
    const source=c.videos.source(id,sourceId),meta=c.metadata(id,source);
    if(allowExternal&&!meta.data.removedAt&&!meta.data.managed&&c.videos.authorized(source)){
      const authority=this.authority(id,sourceId),parent=path.dirname(source.path);
      await c.media.verify(source);const stat=await fs.lstat(parent);
      if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(parent)!==parent)fail('SOURCE_UNTRUSTED','原位置目录不可核验',409);
      const result={projectId:id,source,meta,authority,external:true,parent,parentIdentity:{dev:String(stat.dev),ino:String(stat.ino)}};this.assertAuthority(result);return result;
    }
    if(meta.data.removedAt||!c.videos.authorized(source)||!c.isManaged(id,source))fail('SOURCE_UNTRUSTED','视频尚无有效项目管理授权，请明确重新定位',403);
    c.folders.busyOperations(id,source.path);
    const authority=this.authority(id,sourceId),folderId=c.folders.folderId(id,source.path);
    if(!folderId)fail('SOURCE_UNTRUSTED','视频不在当前项目登记目录中',409);
    const location=await c.folders.resolve(id,folderId),asset=c.matchingAsset(source,meta.data),root=c.lib.roots().find(r=>r.id===asset?.root_id);
    if(!root)fail('SOURCE_UNTRUSTED','视频素材目录已变化',409);
    const result={projectId:id,source,meta,authority,folderId,location,root,rootStamp:await rootIdentity(root)};
    this.assertAuthority(result); return result;
  }
  async checkLocation(s) {
    const c=this.catalog;this.assertAuthority(s);c.folders.busyOperations(s.projectId,s.source.path);
    if(s.external){const st=await fs.lstat(s.parent);if(!st.isDirectory()||st.isSymbolicLink()||await fs.realpath(s.parent)!==s.parent||!same({dev:String(st.dev),ino:String(st.ino)},s.parentIdentity))fail('PREVIEW_STALE','原位置目录变化，请重新核对',409);this.assertAuthority(s);return;}
    const now=await c.folders.resolve(s.projectId,s.folderId);
    if(!same(now,s.location)||await rootIdentity(s.root)!==s.rootStamp)fail('TARGET_CHANGED','核验期间视频目录发生变化，请重新核验',409);
    this.assertAuthority(s);
  }
  async baseline(source,expectedHash) {
    try {
      const value=await mediaContentFingerprint(this.catalog.media,source);
      if(value.fileHash!==expectedHash)fail('SOURCE_CHANGED','视频在内容核验期间变化',409);
      return fingerprint(value);
    } catch(e) {
      // An unavailable/unsupported media comparator never invalidates a trusted
      // whole-file hash; it simply cannot authorize future metadata drift.
      if(['MEDIA_IDENTITY_UNAVAILABLE','MEDIA_IDENTITY_UNSUPPORTED','MEDIA_IDENTITY_BUSY','PROBE_BUSY','PROBE_FAILED','PROBE_TIMEOUT','ENOENT'].includes(e.code))return null;
      throw e;
    }
  }
  view(source) {
    const cached=this.results.get(source.id);
    return cached?.proof===this.catalog.videos.proof(source)?cached.value:{state:'needs_verification',match:null,metadataChanged:false};
  }
  remember(source,value) { this.results.set(source.id,{proof:this.catalog.videos.proof(source),value}); }
  verify(id,sourceId) {
    const key=id+':'+sourceId;
    if(this.pending.has(key))return this.pending.get(key);
    const work=this.perform(id,sourceId).finally(()=>this.pending.delete(key));
    this.pending.set(key,work);return work;
  }
  async perform(id,sourceId) {
    const c=this.catalog;c.project(id);
    const source=c.videos.source(id,sourceId),meta=c.metadata(id,source),authority=this.authority(id,sourceId);
    if(!c.videos.authorized(source)||meta.data.removedAt)fail('SOURCE_UNTRUSTED','此视频尚无有效读取确认或已移除',403);
    try {
      await c.media.verify(source);c.project(id);
      if(this.authority(id,sourceId)!==authority)fail('VIDEO_CONFLICT','核验期间视频资料或读取授权已变化',409);
      if(this.view(source).state!=='verified')this.remember(source,{state:'verified',match:'file',metadataChanged:false});return source;
    } catch(e) { if(e.code!=='SOURCE_CHANGED')throw e; }
    const s=await this.capture(id,sourceId);
    const stat=await fs.lstat(source.path).catch(e=>{if(e.code==='ENOENT')fail('SOURCE_MISSING','原视频文件不存在',404);throw e;});
    const candidate=fileStamp(stat);
    if(!stat.isFile()||stat.isSymbolicLink()||candidate.dev!==source.identity.dev||candidate.ino!==source.identity.ino)fail('SOURCE_CHANGED','原文件已缺失或被替换，请明确预览当前文件',409);
    const checked=await c.hash(source.path,candidate);let match='file',content=meta.data.contentFingerprint||null;
    if(checked.hash!==meta.data.sha256) {
      if(!content) {
        this.remember(source,{state:'needs_verification',match:null,metadataChanged:false});
        fail('SOURCE_CHANGED','文件状态变化，尚无旧内容指纹可比较；请预览后确认当前文件',409);
      }
      const actual=await this.baseline({path:source.path,identity:checked.identity},checked.hash);
      if(!actual)fail('SOURCE_CHANGED','当前格式不能可靠比较内容，请预览后确认当前文件',409);
      if(!same(content,actual)) {
        this.remember(source,{state:'content_changed',match:null,metadataChanged:false});
        fail('SOURCE_CHANGED','视频的画面、声音或时间信息与原登记不同，请预览后选择如何处理',409);
      }
      content=actual;match='media';
    }
    if(match==='file'&&!content)content=await this.baseline({path:source.path,identity:checked.identity},checked.hash);
    await this.checkLocation(s);await c.media.verify({path:source.path,identity:checked.identity});
    return c.videos.tx(()=>{
      c.project(id,true);this.assertAuthority(s);c.folders.busyOperations(id,source.path);
      const probe={path:source.path,name:source.name,identity:checked.identity,durationMs:source.durationMs,codec:source.codec,supported:source.supported};
      this.db.prepare('UPDATE storyboard_video_sources SET data_json=?,updated_at=? WHERE id=? AND project_id=?').run(canonical(probe),Date.now(),sourceId,id);
      if(match==='media'||!meta.data.contentFingerprint&&content) {
        c.index(s.root,source.path,{hash:checked.hash,identity:checked.identity});
        c.record(id,sourceId,{...meta.data,sha256:checked.hash,contentFingerprint:content},meta.row.revision+1);
      } else this.db.prepare('UPDATE assets SET mtime=? WHERE id=?').run(checked.identity.mtimeMs,s.meta.data.mediaAssetId);
      const refreshed=c.videos.source(id,sourceId);c.videos.approve(refreshed);c.approveManaged(refreshed);
      this.remember(refreshed,{state:'verified',match,metadataChanged:match==='media'});return refreshed;
    });
  }
}
