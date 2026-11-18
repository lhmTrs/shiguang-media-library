import fs from 'node:fs/promises';
import sync from 'node:fs';
import {canonical,hash,fail} from './model.mjs';
const stamp=s=>({dev:String(s.dev),ino:String(s.ino),size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs});
const mediaKey=a=>hash({id:a.id,root_id:a.root_id,path:a.path,kind:a.kind,trashed:a.trashed,sha256:a.sha256,dev:a.dev,ino:a.ino,size:a.size,mtime:a.mtime});
export const videoV2Io={
 dependencyKey(mediaId,expected){const media=this.lib.asset(mediaId),root=this.db.prepare('SELECT * FROM roots WHERE id=?').get(media.root_id);return hash({media:mediaKey(media),root:root?{id:root.id,path:root.path,retired:root.retired,online:root.online}:null,expected});},
 applyDependencyChecks(dependencies){for(const dep of Object.values(dependencies))for(const ref of dep.references??[]){if(!ref.mediaId)continue;const check=this.dependencyChecks.get(ref.mediaId+':'+ref.expectedSha256);let key;try{key=this.dependencyKey(ref.mediaId,ref.expectedSha256);}catch{continue;}if(check?.key!==key)continue;if(check.verified)dep.unverifiable=dep.unverifiable.filter(x=>x!=='image-content:'+ref.id);else dep.unverifiable.push('image-file:'+ref.mediaId);}return dependencies;},
 async dependencyProof(view,shotIds){
  const snapshot=this.capture(view,shotIds,{allowMissing:true}),used=new Map();
  for(const shot of snapshot.shots)for(const image of shot.categories.references.dependencies??[])if(image.mediaId)used.set(image.mediaId,image.expectedSha256);
  const proofs=[];
  for(const [mediaId,expected]of used){
   try{const media=this.lib.asset(mediaId),key=this.dependencyKey(mediaId,expected),file=await this.lib.checked(media.path,media.root_id),before=await fs.lstat(file),checked=await this.assets.inspect(mediaId,expected,true),after=await fs.lstat(file);
    if(!before.isFile()||before.isSymbolicLink()||canonical(stamp(before))!==canonical(stamp(after))||checked.state!=='available'||checked.sha256!==expected||this.dependencyKey(mediaId,expected)!==key)fail('ASSET_CONTEXT_CHANGED','分镜实际使用的参考图内容或读取资格已变化',409,{mediaId});
    this.dependencyChecks.set(mediaId+':'+expected,{key,verified:true});proofs.push({path:file,identity:stamp(after),mediaId,expectedSha256:expected,mediaKey:mediaKey(media),dependencyKey:key});
   }catch(error){try{this.dependencyChecks.set(mediaId+':'+expected,{key:this.dependencyKey(mediaId,expected),verified:false});}catch{}fail('ASSET_CONTEXT_CHANGED','分镜实际使用的参考图无法核验',409,{mediaId});}
  }
  if(this.capture(view,shotIds,{allowMissing:true}).shots.some(s=>s.unverifiable.length))fail('ASSET_CONTEXT_CHANGED','分镜使用的外部依赖无法核验',409);
  return proofs;
 },
 async mediaProof(sourceProjectId,videoId,{code='VIDEO_BINDING_CONFLICT'}={}){
  const source=this.source(sourceProjectId,videoId);
  try{const context=await this.catalog.verification.capture(sourceProjectId,videoId);await this.videos.media.verify(context.source);await this.catalog.verification.checkLocation(context);this.catalog.verification.remember(context.source,{state:'verified',match:'file',metadataChanged:false});return {path:source.path,identity:source.identity,sourceProjectId,videoId,authority:context.authority};}
  catch(error){this.catalog.verification.remember(source,{state:'needs_verification',match:null,metadataChanged:false,errorCode:error.code??'SOURCE_UNTRUSTED'});fail(code,'视频当前内容、位置或读取资格无法核验',409,{mediaErrorCode:error.code??'SOURCE_UNVERIFIED'});}
 },
 assertIoProofs(proofs,{code='VIDEO_REVIEW_CONFLICT'}={}){
  for(const proof of proofs){try{const current=sync.lstatSync(proof.path);if(!current.isFile()||current.isSymbolicLink()||sync.realpathSync(proof.path)!==proof.path||canonical(stamp(current))!==canonical(proof.identity))fail(code,'核验后媒体文件再次变化，未提交',409);
   if(proof.mediaId&&(mediaKey(this.lib.asset(proof.mediaId))!==proof.mediaKey||this.dependencyKey(proof.mediaId,proof.expectedSha256)!==proof.dependencyKey))fail(code,'核验后参考图资料再次变化，未提交',409);
   if(proof.videoId&&this.catalog.verification.authority(proof.sourceProjectId,proof.videoId)!==proof.authority)fail(code,'核验后视频读取上下文再次变化，未提交',409);
  }catch(error){if(proof.videoId)try{const source=this.source(proof.sourceProjectId,proof.videoId);this.catalog.verification.remember(source,{state:'needs_verification',match:null,metadataChanged:false,errorCode:'SOURCE_CHANGED'});}catch{}if(proof.mediaId)try{this.dependencyChecks.set(proof.mediaId+':'+proof.expectedSha256,{key:this.dependencyKey(proof.mediaId,proof.expectedSha256),verified:false});}catch{}if(error.code===code)throw error;fail(code,'核验后媒体位置或读取资格变化，未提交',409);}}
 }
};
