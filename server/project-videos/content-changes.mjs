import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {canonical,digest,idOK} from '../project-assets/model.mjs';
import {fail} from '../storyboard-video/model.mjs';
import {privateDirectory} from '../prompt-codex/media.mjs';
import {fileStamp} from './verification.mjs';

const same=(a,b)=>canonical(a)===canonical(b);
const publicShot=s=>({id:s.id,number:s.number});

export class ProjectVideoContentChanges {
  constructor(catalog,journal){this.catalog=catalog;this.journal=journal;this.snapshots=new Map();}
  expected(id,sourceId,input){
    const c=this.catalog;c.project(id,true);
    const source=c.videos.source(id,sourceId),meta=c.metadata(id,source);
    if(meta.data.removedAt)fail('SOURCE_REMOVED','视频记录已移除',409);
    if(input.expectedRevision!==(meta.row?.revision||0))fail('VIDEO_CONFLICT','视频资料已更新，请重新读取后确认',409);
    return {source,meta,adoption:c.adoption(id)};
  }
  otherReferences(source){
    const c=this.catalog,others=[];
    for(const row of c.db.prepare('SELECT * FROM storyboard_video_sources').all()){
      if(row.id===source.id)continue;
      const value=JSON.parse(row.data_json),meta=c.metadata(row.project_id,{...value,...row});
      if(!meta.data.removedAt&&(value.path===source.path||value.identity.dev===source.identity.dev&&value.identity.ino===source.identity.ino))others.push({projectId:row.project_id,sourceId:row.id});
    }
    return others;
  }
  async snapshot(s,context){
    const c=this.catalog,source=context.source;
    const stat=await fs.lstat(source.path),identity=fileStamp(stat);
    if(!stat.isFile()||stat.isSymbolicLink()||await fs.realpath(source.path)!==source.path)fail('SOURCE_UNTRUSTED','当前位置不是可核验的普通视频，请重新定位',409);
    const parent=path.join(c.lib.dataDir,'project-video-change-previews');await privateDirectory(parent);
    await this.cleanup();
    const directory=await fs.mkdtemp(path.join(parent,'preview-'));await fs.chmod(directory,0o700);
    const file=path.join(directory,'candidate'+path.extname(source.name).toLowerCase());
    this.snapshots.set(directory,{file,directoryIdentity:fileStamp(await fs.lstat(directory)),expiresAt:Date.now()+600000});
    const opened=await c.media.open({path:source.path,identity});let output;
    try{
      output=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      const hash=createHash('sha256');
      for await(const chunk of opened.handle.createReadStream({autoClose:false})){
        if(c.media.closing)fail('VIDEO_CLOSING','视频模块正在关闭',503);
        hash.update(chunk);await output.writeFile(chunk);
      }
      if(!same(fileStamp(await opened.handle.stat()),identity))fail('SOURCE_CHANGED','视频在准备预览时变化，请重新检查',409);
      await output.sync();await output.close();output=null;
      await c.media.verify({path:source.path,identity});await c.verification.checkLocation(context);
      const copiedHash=await c.hash(file),fileHash=hash.digest('hex');
      if(copiedHash.hash!==fileHash)fail('SOURCE_CHANGED','临时预览内容核对失败，原视频与采用保持',409);
      const probe=await c.media.probe(file),contentFingerprint=await c.verification.baseline({path:file,identity:copiedHash.identity},fileHash);
      return {file,identity:copiedHash.identity,originalIdentity:identity,hash:fileHash,probe,contentFingerprint};
    }finally{await output?.close();await c.media.release(opened.handle);}
  }
  invalid(adoption,sourceId,durationMs){
    const state=adoption.current;if(!state)return [];
    const takes=new Map(state.takes.map(t=>[t.takeId,t]));
    return (adoption.shots.get(sourceId)||[]).flatMap(shot=>{
      const bad=(takes.get(state.plan.adopted[shot.id])?.segments||[]).filter(s=>s.sourceId===sourceId&&s.outMs>durationMs);
      return bad.length?[{...publicShot(shot),reason:'SOURCE_INTERVAL_OUT_OF_BOUNDS',segments:bad.map(s=>({sourceInMs:s.inMs,sourceOutMs:s.outMs})),newDurationMs:durationMs}]:[];
    });
  }
  preview(id,sourceId,input){
    this.expected(id,sourceId,input);
    return this.journal.start(id,'changes-preview',{...input,sourceId},async s=>{
      const before=this.expected(id,sourceId,input),context=await this.catalog.verification.capture(id,sourceId),candidate=await this.snapshot(s,context);
      this.expected(id,sourceId,input);this.catalog.verification.assertAuthority(context);
      if(this.catalog.adoption(id).stamp!==before.adoption.stamp)fail('ADOPTION_CHANGED','预览期间镜号采用关系变化，请重新预览',409);
      const invalid=this.invalid(before.adoption,sourceId,candidate.probe.durationMs),otherActiveReferences=this.otherReferences({...before.source,identity:candidate.originalIdentity});
      const changeKind=before.meta.data.contentFingerprint&&candidate.contentFingerprint?(same(before.meta.data.contentFingerprint,candidate.contentFingerprint)?'metadata_only':'content_changed'):'not_comparable';
      const preview={changeKind,token:randomUUID(),expiresAt:Date.now()+600000,context,candidate,adoptionStamp:before.adoption.stamp,expectedRevision:input.expectedRevision,invalidShotIds:invalid.map(s=>s.id)};
      // Preparation may take time. The published token and its owned file must
      // expire together, rather than measuring file lifetime from copy start.
      this.snapshots.get(path.dirname(candidate.file)).expiresAt=preview.expiresAt;
      s.preview=preview;
      return {requestId:s.requestId,projectId:id,sourceId,status:'ready',expectedRevision:input.expectedRevision,adoptionStamp:before.adoption.stamp,contentToken:preview.token,expiresAt:preview.expiresAt,changeKind,before:{durationMs:before.source.durationMs,codec:before.source.codec,oldContentAvailable:false},candidate:{durationMs:candidate.probe.durationMs,codec:candidate.probe.codec,supported:candidate.probe.supported,bytes:candidate.identity.size,mediaUrl:`/api/project-videos/projects/${id}/videos/${sourceId}/changes/${preview.token}/media`,thumbnailUrl:null},affectedAdoptedShots:(before.adoption.shots.get(sourceId)||[]).map(publicShot),invalidAdoptedShots:invalid,otherActiveReferences,canAccept:changeKind!=='metadata_only',canTrash:!otherActiveReferences.length&&!!(this.catalog.lib.trashBin||this.catalog.trashInjected),reasons:[]};
    });
  }
  find(id,sourceId,token,action){
    if(!idOK(token))fail('PREVIEW_REQUIRED','请先明确预览并确认当前视频',409);
    this.catalog.project(id);
    const s=this.catalog.db.prepare('SELECT * FROM project_video_operations WHERE project_id=?').all(id).map(r=>JSON.parse(r.data_json)).find(s=>s.namespace==='video-desktop-v1'&&s.action===action&&s.preview?.token===token&&s.preview.context?.source.id===sourceId);
    if(!s||s.status!=='ready'||s.preview.expiresAt<Date.now()||s.instance!==this.catalog.instance)fail('PREVIEW_STALE','预览已过期或应用已重启，请重新预览',409);
    return s.preview;
  }
  async open(id,sourceId,token){
    const p=this.find(id,sourceId,token,'changes-preview');this.catalog.verification.assertAuthority(p.context);
    if(!p.candidate.probe.supported)fail('CODEC_UNSUPPORTED','浏览器不支持此编码，请使用本机播放器核对',415);
    // Keep showing the frozen candidate if the original bytes change again,
    // but never serve it after the registered location loses its authority.
    await this.catalog.verification.checkLocation(p.context);
    const opened=await this.catalog.media.open({path:p.candidate.file,identity:p.candidate.identity});
    try{this.catalog.verification.assertAuthority(p.context);return {...opened,path:p.candidate.file};}
    catch(e){await this.catalog.media.release(opened.handle);throw e;}
  }
  async checkCandidate(id,sourceId,input,p){
    const c=this.catalog,current=this.expected(id,sourceId,input);
    if(input.adoptionStamp!==p.adoptionStamp||current.adoption.stamp!==p.adoptionStamp)fail('ADOPTION_CHANGED','采用关系变化，请重新预览受影响镜号',409);
    await c.verification.checkLocation(p.context);
    const file=await c.hash(current.source.path,p.candidate.originalIdentity);
    if(file.hash!==p.candidate.hash)fail('PREVIEW_STALE','当前文件与刚才预览不同，请重新预览',409);
    c.verification.assertAuthority(p.context);return current;
  }
  history(id,sourceId,data,oldDuration,newDuration){
    const prior=new Map((data.historicalTakeProofs||[]).map(p=>[p.id,p])),result=[];
    for(const row of this.catalog.db.prepare('SELECT * FROM storyboard_video_takes WHERE project_id=?').all(id)){
      const own=JSON.parse(row.data_json).segments.filter(s=>s.sourceId===sourceId);
      if(!own.some(s=>s.outMs>newDuration))continue;
      const hash=digest(row),previous=prior.get(row.id),limit=previous?.hash===hash?Math.max(oldDuration,previous.durationMs):oldDuration;
      if(own.some(s=>s.outMs>limit))fail('INVALID_INTERVAL','历史片段不符合此前视频范围，未接受当前内容',409);
      result.push({id:row.id,hash,durationMs:limit});
    }
    return result;
  }
  unbindShots(id,shotIds){
    if(!shotIds.length)return;
    const c=this.catalog,row=c.videos.planRow(id);if(!row)return;
    const data=JSON.parse(row.data_json),remove=new Set(shotIds);
    const adopted=Object.fromEntries(Object.entries(data.adopted).filter(([shotId])=>!remove.has(shotId)));
    // Preserve the prior timing hash. Removing a reference does not approve any
    // concurrent storyboard timing edit or bless the remaining stale adopts.
    c.db.prepare('UPDATE storyboard_video_plans SET data_json=?,revision=?,updated_at=? WHERE id=?').run(canonical({adopted}),row.revision+1,Date.now(),id);
  }
  accept(id,sourceId,input){
    this.catalog.assertRenderUnused(this.catalog.videos.source(id,sourceId));
    if(input.confirmAcceptContent!==true||!Array.isArray(input.confirmedUnbindShotIds))fail('CONTENT_CONFIRMATION_REQUIRED','请确认采用当前内容和需要解除的镜号',409);
    return this.journal.start(id,'accept-change',{...input,sourceId},async s=>{
      const c=this.catalog,p=this.find(id,sourceId,input.contentToken,'changes-preview'),current=await this.checkCandidate(id,sourceId,input,p);
      if(!same([...input.confirmedUnbindShotIds].sort(),[...p.invalidShotIds].sort()))fail('UNBIND_CONFIRMATION_REQUIRED','请精确确认因新时长失效的采用镜号',409);
      c.assertRenderUnused(current.source);
      if(p.changeKind==='metadata_only')fail('CONTENT_UNCHANGED','视频内容一致，无需接受新内容；请刷新并沿用原视频',409);
      const kind=p.changeKind==='content_changed'?'user_accepted_change':'user_accepted_unverified_current';
      const result=c.videos.tx(()=>{
        c.project(id,true);c.assertRenderUnused(current.source);c.verification.assertAuthority(p.context);c.folders.busyOperations(id,current.source.path);
        if(c.adoption(id).stamp!==p.adoptionStamp)fail('ADOPTION_CHANGED','采用关系在确认时变化',409);
        this.unbindShots(id,p.invalidShotIds);
        const probe={path:current.source.path,name:current.source.name,identity:p.candidate.originalIdentity,durationMs:p.candidate.probe.durationMs,codec:p.candidate.probe.codec,supported:p.candidate.probe.supported};
        c.db.prepare('UPDATE storyboard_video_sources SET data_json=?,updated_at=? WHERE id=? AND project_id=?').run(canonical(probe),Date.now(),sourceId,id);
        c.index(p.context.root,current.source.path,{identity:probe.identity,hash:p.candidate.hash});
        const historicalTakeProofs=this.history(id,sourceId,current.meta.data,current.source.durationMs,p.candidate.probe.durationMs);
        const data={...current.meta.data,historicalTakeProofs,sha256:p.candidate.hash,contentFingerprint:p.candidate.contentFingerprint,contentAcceptance:{kind,requestId:s.requestId,at:Date.now(),previousSha256:current.meta.data.sha256}};
        c.record(id,sourceId,data,current.meta.row.revision+1);
        const source=c.videos.source(id,sourceId);c.videos.approve(source);c.approveManaged(source);c.verification.remember(source,{state:'verified',match:'file',metadataChanged:false});
        s.previous={source:current.source,metadata:current.meta.data,adoptionStamp:p.adoptionStamp};
        const result={requestId:s.requestId,projectId:id,sourceId,status:'completed',revision:current.meta.row.revision+1,keptAdoptedShotIds:(current.adoption.shots.get(sourceId)||[]).filter(s=>!p.invalidShotIds.includes(s.id)).map(s=>s.id),unboundShotIds:p.invalidShotIds,acceptanceKind:kind,fileAction:'none'};
        // Commit the result with the mutation, not after returning from it.
        s.result=result;s.status='completed';this.journal.save(s);return result;
      });return result;
    });
  }
  removePreview(id,sourceId,input){
    this.catalog.assertRenderUnused(this.catalog.videos.source(id,sourceId));
    this.expected(id,sourceId,input);
    return this.journal.start(id,'remove-preview',{...input,sourceId},async s=>{
      const c=this.catalog,current=this.expected(id,sourceId,input),authority=c.verification.authority(id,sourceId),otherActiveReferences=[],reasons=[];
      let file=null,context=null;

      try{
        context=await c.verification.capture(id,sourceId);
        const st=await fs.lstat(current.source.path);
        if(!st.isFile()||st.isSymbolicLink())fail('SOURCE_UNTRUSTED','当前位置不是普通文件',409);
        file=await c.hash(current.source.path,fileStamp(st));await c.verification.checkLocation(context);
      }catch(e){reasons.push(e.code||'SOURCE_UNAVAILABLE');}
      otherActiveReferences.push(...this.otherReferences({...current.source,...(file?{identity:file.identity}:{})}));
      if(otherActiveReferences.length)reasons.push('OTHER_ACTIVE_REFERENCES');
      if(c.verification.authority(id,sourceId)!==authority||c.adoption(id).stamp!==current.adoption.stamp)fail('VIDEO_CONFLICT','核对期间资料变化，请重新核对',409);
      const token=randomUUID(),expiresAt=Date.now()+120000;
      s.preview={token,expiresAt,context:{source:current.source,projectId:id,authority},locationContext:context,file,adoptionStamp:current.adoption.stamp,expectedRevision:input.expectedRevision};
      return {requestId:s.requestId,projectId:id,sourceId,status:'ready',removalToken:token,expiresAt,adoptionStamp:current.adoption.stamp,affectedAdoptedShots:(current.adoption.shots.get(sourceId)||[]).map(publicShot),otherActiveReferences,canTrash:!!file&&!reasons.length&&!!(c.lib.trashBin||c.trashInjected),reasons};
    });
  }
  remove(id,sourceId,input){
    this.catalog.assertRenderUnused(this.catalog.videos.source(id,sourceId));
    if(!['keep','trash'].includes(input.fileAction)||input.confirmUnbind!==true)fail('REMOVAL_CONFIRMATION_REQUIRED','请选择保留文件或移入废纸篓并确认解除采用',409);
    return this.journal.start(id,'remove',{...input,sourceId},async s=>{
      const c=this.catalog,p=this.find(id,sourceId,input.removalToken,'remove-preview'),current=this.expected(id,sourceId,input);c.assertRenderUnused(current.source);
      if(current.adoption.stamp!==p.adoptionStamp||input.adoptionStamp!==p.adoptionStamp||c.verification.authority(id,sourceId)!==p.context.authority)fail('VIDEO_CONFLICT','移除影响已变化，请重新核对',409);
      if(input.fileAction==='trash'){
        if(!p.file||!p.locationContext||this.otherReferences({...current.source,identity:p.file.identity}).length||!c.lib.trashBin&&!c.trashInjected)fail('TRASH_UNAVAILABLE','此文件不能移入废纸篓，请选择保留文件',409);
        // Release is a user step: never destroy an active stream or process.
        if(c.media.responses.size||c.media.handles.size||c.media.children.size)fail('VIDEO_IN_USE','请先暂停并关闭视频预览后再移入废纸篓',409);
        await c.verification.checkLocation(p.locationContext);
        const check=await c.hash(current.source.path,p.file.identity);
        if(check.hash!==p.file.hash)fail('PREVIEW_STALE','文件在确认后变化，请重新核对',409);
        c.folders.busyOperations(id,current.source.path);s.file=current.source.path;this.journal.save(s);
      }
      const unboundShotIds=(current.adoption.shots.get(sourceId)||[]).map(s=>s.id);
      const result={requestId:s.requestId,projectId:id,sourceId,status:'completed',record:{removed:true,unboundShotIds},file:{action:input.fileAction,status:input.fileAction==='keep'?'kept':'unknown'}};
      c.videos.tx(()=>{
        c.project(id,true);c.assertRenderUnused(current.source);
        if(c.adoption(id).stamp!==p.adoptionStamp||c.verification.authority(id,sourceId)!==p.context.authority)fail('VIDEO_CONFLICT','确认期间资料或采用关系变化',409);
        this.unbindShots(id,unboundShotIds);c.record(id,sourceId,{...current.meta.data,removedAt:Date.now()},(current.meta.row?.revision||0)+1);
        s.partial={record:result.record,file:result.file};s.result=result;s.status=input.fileAction==='keep'?'completed':'running';this.journal.save(s);
      });
      if(input.fileAction==='trash'){
        s.dispatched=true;this.journal.save(s);
        try{
          await c.media.verify({path:current.source.path,identity:p.file.identity});
          if(this.otherReferences({...current.source,identity:p.file.identity}).length)fail('OTHER_ACTIVE_REFERENCES','文件新增了其他引用，已保留原文件',409);
          c.assertRenderUnused(current.source);const trashedPath=await c.fileOperations.trash(current.source.path);result.file.status='trashed';
          if(current.meta.data.mediaAssetId)c.db.prepare('UPDATE assets SET path=?,trashed=1,online=0,file_status=? WHERE id=? AND path=?').run(trashedPath,'missing',current.meta.data.mediaAssetId,current.source.path);
        }catch(e){result.status='partial';result.file={action:'trash',status:e.code==='TRASH_UNSETTLED'||e.killed||e.signal||e.effectUnknown||e.code==='ETIMEDOUT'?'unknown':'failed',code:e.code||'TRASH_FAILED',reason:e.status?e.message:'记录已移除，文件移入废纸篓未确认；请核对原请求'};}
      }
      return result;
    });
  }
  async cleanup(all=false){
    if(this.catalog.media.handles.size||this.catalog.media.responses.size)return;
    const parent=path.join(this.catalog.lib.dataDir,'project-video-change-previews');
    for(const [directory,item] of this.snapshots){
      if(!all&&item.expiresAt>Date.now())continue;
      if(path.dirname(directory)!==parent||path.dirname(item.file)!==directory)continue;
      try{const st=await fs.lstat(directory);if(st.isSymbolicLink()||String(st.dev)!==item.directoryIdentity.dev||String(st.ino)!==item.directoryIdentity.ino||await fs.realpath(directory)!==directory)continue;const names=await fs.readdir(directory);if(names.length!==1||names[0]!==path.basename(item.file))continue;const file=await fs.lstat(item.file);if(!file.isFile()||file.isSymbolicLink())continue;await fs.unlink(item.file);await fs.rmdir(directory);this.snapshots.delete(directory);}catch(e){if(e.code==='ENOENT')this.snapshots.delete(directory);}
    }
  }

}
