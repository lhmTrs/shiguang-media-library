import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {canonical,digest,idOK} from '../project-assets/model.mjs';
import {fail} from '../storyboard-video/model.mjs';
import {within} from '../fs-identity.mjs';
import {folderName,folderIdentity,sameFolder,nameKey} from './folders.mjs';
const run=promisify(execFile);
const stamp=st=>({dev:String(st.dev),ino:String(st.ino),size:st.size,mtimeMs:st.mtimeMs,ctimeMs:st.ctimeMs});
const equal=(a,b)=>canonical(a)===canonical(b);
const exists=async file=>{try{return await fs.lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const shotUnion=(adoption,sourceIds)=>{
 const shots=new Map();
 for(const sourceId of sourceIds)for(const shot of adoption.shots.get(sourceId)||[]){
  const item=shots.get(shot.id)||{id:shot.id,number:shot.number,sourceIds:[]};
  if(!item.sourceIds.includes(sourceId))item.sourceIds.push(sourceId);
  shots.set(shot.id,item);
 }
 return [...shots.values()];
};
const exactShotIds=(actual,shots)=>Array.isArray(actual)&&actual.length===shots.length&&new Set(actual).size===actual.length&&shots.every(s=>actual.includes(s.id));
const abandonedCode = 'OPERATION_ABANDONED';
const abandonedMessage = '已放下原移动请求，请重新核对';

export class ProjectVideoFileOperations {
 constructor(catalog,{trash}={}) {this.catalog=catalog;this.trash=trash||(async(file)=>{if(!catalog.lib.trashBin)fail('TRASH_UNAVAILABLE','系统废纸篓不可用，未执行永久删除',409);const {stdout}=await run(catalog.lib.trashBin,[file],{timeout:30000});const target=JSON.parse(stdout);if(typeof target!=='string'||!path.isAbsolute(target)||!/(^|\/)\.Trash(es)?\//.test(target))fail('TRASH_UNSETTLED','废纸篓结果尚未核清，请核对原操作',409);return target;});this.active=new Set();}
 get db(){return this.catalog.db;}
 readOperation(id, requestId) {
  if (!idOK(requestId)) fail('INVALID_REQUEST_ID', '文件操作编号无效');
  const row = this.db.prepare('SELECT data_json FROM project_video_operations WHERE id=? AND project_id=?').get(requestId, id);
  if (!row) fail('OPERATION_NOT_FOUND', '未找到原文件操作', 404);
  const data = JSON.parse(row.data_json);
  if (data.namespace === 'video-desktop-v1') fail('OPERATION_NOT_FOUND', '此编号属于视频桌面任务，请查询原桌面操作', 404);
  return { data, stored: row.data_json };
 }
 row(id,requestId){return this.readOperation(id,requestId).data;}
 save(id,requestId,data){this.db.prepare('UPDATE project_video_operations SET data_json=?,updated_at=? WHERE id=? AND project_id=?').run(canonical(data),Date.now(),requestId,id);}
 replacePreview(id, requestId, stored, data) {
  // Both execution and abandonment replace the same durable preview exactly once.
  const result = this.db.prepare('UPDATE project_video_operations SET data_json=?,updated_at=? WHERE id=? AND project_id=? AND data_json=?')
   .run(canonical(data), Date.now(), requestId, id, stored);
  return result.changes === 1;
 }
 dto(requestId,s){
  if (s.status === 'cancelled') return {requestId, status:'cancelled', phase:'preview', errorCode:abandonedCode, canRecover:false};
  const notStarted=s.input?.kind==='move-videos'&&s.status==='preview',status=notStarted||s.status==='running'&&!this.active.has(requestId)?'unknown':s.status;
  return{requestId,status,description:s.description,error:notStarted?'当前只有预览，执行尚未确认，请核对原请求；视频未报告移动完成':s.error,...(notStarted?{phase:'preview',errorCode:'OPERATION_NOT_STARTED'}:{}),folderId:s.resultFolderId,rolesRevision:s.roles?.revision,unboundShotIds:s.unboundShotIds||[],...(s.input?.kind==='move-videos'?{items:this.items(s,status)}:{}),canRecover:!notStarted&&s.kind!=='create-folder'&&(['unknown','failed'].includes(status))};
 }
 items(s,status){return s.input.sourceIds.map(sourceId=>{const move=s.moves.find(m=>m.sourceId===sourceId),steps=s.steps.filter(x=>x.itemId===sourceId),moved=steps.some(x=>x.status==='moved'),touched=steps.length>0;let state='not-run';if(status==='ready')state='ready';else if(status==='running')state='not-run';else if(status==='unknown'&&steps.some(x=>x.status!=='rolled-back'))state='unknown';else if(s.failedItemId===sourceId)state='failed';else if(touched)state=moved||steps.some(x=>x.status==='rolled-back')?'rolled-back':'failed';return{sourceId,status:state,destinationPath:move?.target,unboundShotIds:status==='ready'?(s.plan.sourceUnbindShots||[]).filter(x=>x.sourceIds.includes(sourceId)).map(x=>x.id):[],error:['failed','unknown'].includes(state)?s.error:undefined};});}
 roleSnapshot(id){const {revision,rejectFolderId}=this.catalog.folders.roleState(id);return{revision,rejectFolderId};}
 checkRoles(id,s){const current=this.roleSnapshot(id);if(s.roles?!equal(current,s.roles):current.rejectFolderId!==null)fail('REJECT_AREA_CHANGED','废片收纳处在确认后变化，请重新核对',409);}
 async snapshot(file){const root=await fs.lstat(file);if(root.isSymbolicLink())fail('SYMLINK_REJECTED','目录操作不处理符号链接，请先在访达中核对',409);const nodes=[];const visit=async p=>{const st=await fs.lstat(p);if(st.isSymbolicLink()||!st.isDirectory()&&!st.isFile())fail('UNSUPPORTED_ENTRY','目录中有链接或特殊文件，未开始操作',409);nodes.push({path:p,kind:st.isDirectory()?'directory':'file',identity:stamp(st)});if(st.isDirectory())for(const name of (await fs.readdir(p)).sort()){if(name.startsWith('.shiguang-video-'))fail('OPERATION_UNSETTLED','目录内仍有未结清操作，未开始整理',409);await visit(path.join(p,name));}};await visit(file);return nodes;}
 async unchanged(nodes){for(const n of nodes){const st=await exists(n.path);const changed=!st||st.isSymbolicLink()||(n.kind==='directory'?(!st.isDirectory()||String(st.dev)!==n.identity.dev||String(st.ino)!==n.identity.ino):!equal(stamp(st),n.identity));if(changed)fail('FILE_OPERATION_CONFLICT','文件或目录在确认后发生变化，请重新预览',409);}const dirs=nodes.filter(n=>n.kind==='directory');for(const n of dirs){const expected=nodes.filter(x=>path.dirname(x.path)===n.path).map(x=>path.basename(x.path)).sort();if(!equal((await fs.readdir(n.path)).sort(),expected))fail('FILE_OPERATION_CONFLICT','目录内容在确认后变化，请重新预览',409);}}
 async preview(id,input){
  this.catalog.project(id,true);
  if(!idOK(input.requestId))fail('INVALID_REQUEST_ID','文件操作编号无效');
  if(input.kind!=='delete-folder'&&input.mode!==undefined)fail('INVALID_OPERATION','移动和重命名不能附带删除方式');
  const args=digest(input),old=this.db.prepare('SELECT * FROM project_video_operations WHERE id=?').get(input.requestId);
  if (old) {
   const data = JSON.parse(old.data_json);
   if (old.project_id !== id || data.args !== args) fail('REQUEST_ID_CONFLICT', '操作编号已用于其他输入', 409);
   if (data.status === 'cancelled') fail(abandonedCode, abandonedMessage, 409);
   return data.plan;
  }
  const folders=this.catalog.folders,rows=folders.rows(id),roles=this.roleSnapshot(id);
  const batch=input.kind==='move-videos',videoMove=batch||input.kind==='move-video',explicitUnbind=input.unbindAdoptions===true;
  if(batch&&(!Array.isArray(input.sourceIds)||input.sourceIds.length<1||input.sourceIds.length>50||input.sourceIds.some(x=>!idOK(x))||new Set(input.sourceIds).size!==input.sourceIds.length))fail('INVALID_SOURCE_IDS','请选择1至50个不重复的视频');
  if((batch||explicitUnbind)&&(!Number.isSafeInteger(input.expectedRolesRevision)||input.expectedRolesRevision!==roles.revision))fail('REJECT_AREA_CHANGED','废片收纳处版本已变化，请重新核对',409);
  if(input.expectedRolesRevision!==undefined&&input.expectedRolesRevision!==roles.revision)fail('REJECT_AREA_CHANGED','废片收纳处版本已变化，请重新核对',409);
  // The role is a pointer to an approved physical folder, never a name lookup.
  if(roles.rejectFolderId)await folders.resolve(id,roles.rejectFolderId,{write:true});
  const root=await folders.resolve(id,'root',{write:true,create:true});
  let source,target,folder,mode=input.mode,moves=[];
  if(videoMove){
   const ids=batch?input.sourceIds:[input.sourceId];
   target=(await folders.resolve(id,input.destinationFolderId||'root',{write:true})).target;
   if(folders.inRejectArea(id,input.destinationFolderId||'root',rows)&&!explicitUnbind)fail('UNBIND_MODE_REQUIRED','移入废片收纳处前请明确确认解除采用',409);
   const physical=new Set();
   for(const sourceId of ids){
    this.catalog.assertBindableForMove(id,sourceId);
    const video=await this.catalog.verifiedSource(id,sourceId),key=video.identity.dev+':'+video.identity.ino;
    if(physical.has(key))fail('DUPLICATE_SOURCE','所选记录指向同一个文件，请只选择一项',409);
    physical.add(key);
    const destination=path.join(target,path.basename(video.path));
    if(video.path===destination)fail('SAME_LOCATION','视频已经在这个位置，请移除该项后继续');
    moves.push({source:video.path,target:destination,key:batch?sourceId:'item',sourceId,kind:'move'});
   }
   source=moves[0].source;
  }else if(['rename-folder','move-folder','delete-folder'].includes(input.kind)){
   folder=folders.row(id,input.folderId);source=(await folders.resolve(id,input.folderId,{write:true})).target;folders.busy(id,source);
   if(input.kind==='rename-folder')target=path.dirname(source);
   if(input.kind==='move-folder')target=(await folders.resolve(id,input.destinationFolderId||'root',{write:true})).target;
   if(input.kind==='delete-folder'&&!['trash','contents-to-root'].includes(mode))fail('INVALID_DELETE_MODE','请选择全部删除或只删除文件夹');
   if(input.kind==='delete-folder')moves=mode==='trash'?[{source,target:null,key:'trash',kind:'trash'}]:(await fs.readdir(source)).sort().map(name=>({source:path.join(source,name),target:path.join(root.target,name),key:name,kind:'move'}));
   else{
    const name=input.kind==='rename-folder'?folderName(input.name):path.basename(source),destination=path.join(target,name);
    if(source===destination)fail('SAME_LOCATION','文件夹已经在这个位置');
    if(within(source,destination))fail('INVALID_FOLDER_MOVE','文件夹不能移动到自身或自己的子目录');
    moves=[{source,target:destination,key:'item',kind:'move'}];
   }
  }else fail('INVALID_OPERATION','未知目录操作');
  if(input.kind==='delete-folder'&&mode==='trash'&&!this.catalog.lib.trashBin&&!this.catalog.trashInjected)fail('TRASH_UNAVAILABLE','系统废纸篓不可用，不能执行全部删除',409);
  for(const m of moves){folders.busyOperations(id,m.source);if(m.target)folders.busyOperations(id,m.target);}
  const conflicts=[],reserved=new Set(),selectedPaths=new Set(moves.map(m=>m.source));
  for(const move of moves){
   if(!move.target)continue;
   const sourceStat=await fs.lstat(move.source),names=await fs.readdir(path.dirname(move.target));
   const actual=names.find(n=>nameKey(n)===nameKey(path.basename(move.target)));
   if(actual)move.target=path.join(path.dirname(move.target),actual);
   if(actual||reserved.has(nameKey(move.target))){
    const choice=input.choices?.[move.key],targetSources=this.catalog.videos.sources(id).filter(s=>s.path===move.target&&!this.catalog.metadata(id,s).data.removedAt),targetSource=targetSources[0];
    const conflict={key:move.key,name:path.basename(move.target),sourceName:path.basename(move.source),targetName:path.basename(move.target),targetVideoId:targetSource?.id,adoptedShots:shotUnion(this.catalog.adoption(id),targetSources.map(x=>x.id)),choice};conflicts.push(conflict);
    if(choice==='rename'){
     const ext=sourceStat.isDirectory()?'':path.extname(move.target),stem=path.basename(move.target,ext);let n=0,next;
     do{next=path.join(path.dirname(move.target),stem+'_'+n+++ext);}while(names.some(n=>nameKey(n)===nameKey(path.basename(next)))||await exists(next)||reserved.has(nameKey(next)));
     move.target=next;
    }else if(choice==='overwrite'){
     if(reserved.has(nameKey(move.target))||selectedPaths.has(move.target))fail('BATCH_TARGET_CONFLICT','同批视频不能互相覆盖，请改名或取消',409);
     if(sourceStat.isDirectory()||(await fs.lstat(move.target)).isDirectory())fail('FOLDER_EXISTS','同名文件夹请改名或取消，不直接覆盖或合并文件夹',409);
     move.overwrite=move.target;move.overwriteVideoIds=targetSources.map(x=>x.id);
    }
   }
   reserved.add(nameKey(move.target));
  }
  const nodes=[];
  for(const move of moves){nodes.push(...await this.snapshot(move.source));if(move.overwrite)nodes.push(...await this.snapshot(move.overwrite));}
  if(input.kind==='delete-folder'&&mode==='contents-to-root')nodes.push({path:source,kind:'directory',identity:stamp(await fs.lstat(source))});
  const parentPaths=[...new Set([root.target,...moves.flatMap(m=>[path.dirname(m.source),m.target&&path.dirname(m.target)]).filter(Boolean)])],parents=[];
  for(const file of parentPaths){if(!within(root.target,file)||await fs.realpath(file)!==file)fail('TARGET_CHANGED','操作目录越界或位置已变化',409);parents.push({path:file,identity:folderIdentity(await fs.lstat(file))});}
  const sourceRows=this.catalog.videos.sources(id).filter(s=>nodes.some(n=>n.kind==='file'&&n.path===s.path)&&!this.catalog.metadata(id,s).data.removedAt),removeIds=new Set(moves.flatMap(m=>m.overwriteVideoIds||[]));
  if(input.kind==='delete-folder'&&mode==='trash')for(const s of sourceRows)removeIds.add(s.id);
  for(let i=0;i<sourceRows.length;i++){const s=sourceRows[i];if(!this.catalog.isManaged(id,s))fail('LEGACY_VIDEO_REQUIRED','目录含未升级或未核验的视频，请先升级或重新定位',409);sourceRows[i]=await this.catalog.verifiedSource(id,s.id);}
  const adoption=this.catalog.adoption(id),movingIds=videoMove?sourceRows.filter(v=>moves.some(m=>m.source===v.path)).map(v=>v.id):[];
  if(input.kind==='move-folder'&&folders.inRejectArea(id,input.destinationFolderId||'root',rows)&&shotUnion(adoption,sourceRows.map(v=>v.id)).length)fail('ADOPTED_FOLDER_MOVE_REJECTED','文件夹内有已采用视频，请逐项选择视频并确认解除采用',409);
  const sourceUnbindIds=videoMove&&explicitUnbind?movingIds:[],sourceUnbindShots=shotUnion(adoption,sourceUnbindIds),overwriteTargetUnbindShots=shotUnion(adoption,[...removeIds]),affected=shotUnion(adoption,[...new Set([...sourceUnbindIds,...removeIds])]);
  const description=videoMove?(batch?'批量移动视频':'移动视频'):input.kind==='rename-folder'?'重命名文件夹':input.kind==='move-folder'?'移动文件夹':mode==='trash'?'将文件夹及全部内容移入废纸篓':'将内容移回项目根目录后删除文件夹';
  const plan={requestId:input.requestId,description,conflicts,affectedShots:affected,sourceUnbindShots,overwriteTargetUnbindShots,willUnbindAdoptions:explicitUnbind||affected.length>0,adoptionStamp:adoption.stamp,rolesRevision:roles.revision,destinationFolderId:input.destinationFolderId||'root',files:nodes.filter(n=>n.kind==='file').length,folders:nodes.filter(n=>n.kind==='directory').length,ready:conflicts.every(c=>['rename','overwrite'].includes(c.choice))};
  const data={args,input,plan,roles,root:root.target,source,folderId:folder?.id,nodes,parents,moves,sourceRows:sourceRows.map(s=>({id:s.id,path:s.path,identity:s.identity,revision:this.catalog.metadata(id,s).row?.revision||0})),folderRows:rows,folderStamp:digest(rows),removeIds:[...removeIds],sourceUnbindIds,strictUnbind:batch||explicitUnbind,adoptionStamp:adoption.stamp,status:'preview',description,steps:[],created:Date.now()};
  plan.previewHash=digest(data);data.plan=plan;
  this.checkRoles(id,data);
  const now=Date.now();this.db.prepare('INSERT INTO project_video_operations VALUES(?,?,?,?,?)').run(input.requestId,id,canonical(data),now,now);return plan;
 }
 async guard(id,s){this.catalog.project(id,true);if(s.input.kind!=='delete-folder'&&s.input.mode!==undefined)fail('INVALID_OPERATION','移动和重命名不能附带删除方式');this.checkRoles(id,s);if(s.roles?.rejectFolderId)await this.catalog.folders.resolve(id,s.roles.rejectFolderId,{write:true});if(digest(this.catalog.folders.rows(id))!==s.folderStamp)fail('FOLDER_CONFLICT','目录资料在确认后变化，请重新预览',409);for(const p of s.parents){const st=await exists(p.path);if(!st||!st.isDirectory()||st.isSymbolicLink()||!sameFolder(folderIdentity(st),p.identity)||await fs.realpath(p.path)!==p.path)fail('TARGET_CHANGED','目录位置在确认后变化，请重新预览',409);}for(const old of s.sourceRows){const current=this.catalog.assertBindableForMove(id,old.id);if(current.path!==old.path||!equal(current.identity,old.identity)||(this.catalog.metadata(id,current).row?.revision||0)!==old.revision)fail('VIDEO_CONFLICT','视频资料在确认后变化，请重新预览',409);}if(this.catalog.adoption(id).stamp!==s.adoptionStamp)fail('ADOPTION_CHANGED','采用镜号在确认后变化，请重新确认受影响镜号',409);if(s.folderId)this.catalog.folders.busy(id,s.source,s.input.requestId);for(const m of s.moves){this.catalog.folders.busyOperations(id,m.source,s.input.requestId);if(m.target)this.catalog.folders.busyOperations(id,m.target,s.input.requestId);}await this.unchanged(s.nodes);}
 abandon(id, requestId) {
  this.catalog.project(id, true);
  const {data, stored} = this.readOperation(id, requestId);
  if (data.input?.kind !== 'move-videos' || data.input.unbindAdoptions === true) {
   fail('INVALID_OPERATION', '只有普通批量移动可以放下原请求', 409);
  }
  if (data.status !== 'preview') return this.dto(requestId, data);
  const cancelled = {...data, status:'cancelled'};
  if (this.replacePreview(id, requestId, stored, cancelled)) return this.dto(requestId, cancelled);
  return this.dto(requestId, this.row(id, requestId));
 }
 async execute(id, input) {
  const {requestId} = input;
  const {data, stored} = this.readOperation(id, requestId);
  if (data.status === 'cancelled') fail(abandonedCode, abandonedMessage, 409);
  if (data.status !== 'preview') return this.dto(requestId, data);
  if (input.previewHash !== data.plan.previewHash || !data.plan.ready) {
   fail('PREVIEW_REQUIRED', '请先处理全部冲突并确认当前预览', 409);
  }
  if (data.strictUnbind && (input.confirmUnbind !== true || !exactShotIds(input.confirmedUnbindShotIds, data.plan.affectedShots))) {
   fail('UNBIND_CONFIRMATION_REQUIRED', '请完整确认本批视频及覆盖目标影响的全部镜号', 409);
  }
  if (data.plan.affectedShots.length && input.confirmUnbind !== true) {
   fail('UNBIND_CONFIRMATION_REQUIRED', '此视频仍被镜号采用，覆盖或删除会解除关联，请确认', 409);
  }
  const running = {...data, status:'running', instance:this.catalog.instance};
  if (!this.replacePreview(id, requestId, stored, running)) {
   const current = this.row(id, requestId);
   if (current.status === 'cancelled') fail(abandonedCode, abandonedMessage, 409);
   return this.dto(requestId, current);
  }
  this.active.add(requestId);
  try {
   const work = this.catalog.withActivity(() => this.catalog.media.track(() => this.catalog.serial(() => this.perform(id, requestId, running))));
   work.finally(() => this.active.delete(requestId)).catch(() => {});
  } catch (error) {
   this.active.delete(requestId);
   throw error;
  }
  return this.dto(requestId, running);
 }
 async step(id,requestId,s,source,target,kind='move'){const original=s.nodes.find(n=>n.path===source);if(!original)fail('FILE_OPERATION_CONFLICT','原操作未包含此来源',409);await this.unchanged(s.nodes.filter(n=>within(source,n.path)));s.steps.push({source,target,kind,status:'planned',identity:original.identity,itemId:s.currentItemId});this.save(id,requestId,s);const step=s.steps.at(-1);if(kind==='trash'){step.target=await this.trash(source);step.status='moved';this.save(id,requestId,s);return;}
  const st=await fs.lstat(source);if(!equal(stamp(st),original.identity))fail('SOURCE_CHANGED','原文件在执行前已变化，未移动',409);if(st.isSymbolicLink()||await fs.realpath(path.dirname(source))!==path.dirname(source)||await fs.realpath(path.dirname(target))!==path.dirname(target))fail('TARGET_CHANGED','文件位置在操作时变化',409);
  if(st.isDirectory()){await fs.mkdir(target,{mode:0o700});step.reservation=folderIdentity(await fs.lstat(target));this.save(id,requestId,s);if((await fs.readdir(target)).length||!sameFolder(folderIdentity(await fs.lstat(target)),step.reservation))fail('TARGET_CHANGED','目标目录在操作时变化',409);await fs.rename(source,target);}
  else {await fs.link(source,target);const copied=await fs.lstat(target),after=await fs.lstat(source);if(copied.ino!==st.ino||after.ino!==st.ino||copied.dev!==st.dev||after.size!==st.size||after.mtimeMs!==st.mtimeMs)fail('SOURCE_CHANGED','移动期间文件发生变化',409);await fs.unlink(source);}
  step.status='moved';step.after=stamp(await fs.lstat(target));this.save(id,requestId,s);
 }
 mapped(s,file){for(const m of s.moves){if(m.overwrite===file)return null;if(m.target&&within(m.source,file))return path.join(m.target,path.relative(m.source,file));if(m.kind==='trash'&&within(m.source,file))return null;}return file;}
 async perform(id,requestId,s){let commitAttempted=false,completed;try{await this.guard(id,s);const recovery=path.join(s.root,'.shiguang-video-operations',requestId);if(s.moves.some(m=>m.overwrite)){await fs.mkdir(recovery,{recursive:true,mode:0o700});if(await fs.realpath(recovery)!==recovery)fail('TARGET_CHANGED','恢复目录位置异常',409);}
   for(const m of s.moves){s.currentItemId=m.sourceId;s.failedItemId=m.sourceId;if(m.overwrite)await this.step(id,requestId,s,m.overwrite,path.join(recovery,randomUUID()+path.extname(m.overwrite)));await this.step(id,requestId,s,m.source,m.target,m.kind);}delete s.currentItemId;delete s.failedItemId;
   if(s.input.kind==='delete-folder'&&s.input.mode==='contents-to-root'){await fs.rmdir(s.source);s.sourceDirectoryRemoved=true;this.save(id,requestId,s);}
   // Recheck the frozen original identities after all asynchronous moves. A new
   // lstat must never turn a replacement into the old source's approved identity.
   for(const n of s.nodes){const file=this.mapped(s,n.path);if(!file||n.path===s.source&&s.input.kind==='delete-folder')continue;const st=await fs.lstat(file),expected=s.steps.find(x=>x.source===n.path)?.after||n.identity;if(st.isSymbolicLink()||String(st.dev)!==expected.dev||String(st.ino)!==expected.ino||n.kind==='file'&&(!st.isFile()||st.size!==expected.size||st.mtimeMs!==expected.mtimeMs||st.ctimeMs!==expected.ctimeMs))fail('SOURCE_CHANGED','原文件在整理期间发生变化，未更新原关联',409);}
   const relocated=[];for(const old of s.sourceRows){if(s.removeIds.includes(old.id))continue;const file=this.mapped(s,old.path);if(file&&file!==old.path){const meta=this.catalog.metadata(id,this.catalog.videos.source(id,old.id)).data,checked=await this.catalog.hash(file);if(!meta.sha256||checked.hash!==meta.sha256||checked.identity.dev!==old.identity.dev||checked.identity.ino!==old.identity.ino||checked.identity.size!==old.identity.size||checked.identity.mtimeMs!==old.identity.mtimeMs)fail('SOURCE_CHANGED','移动后的内容与原视频不同，未更新原关联',409);relocated.push({old,file,identity:checked.identity});}}
   const nextFolders=[];for(const row of s.folderRows){const old=path.join(s.root,...row.relativePath.split('/'));let file=this.mapped(s,old);if(old===s.source&&s.input.kind==='delete-folder')file=null;if(file!==old)nextFolders.push({row,file,identity:file?folderIdentity(await fs.lstat(file)):null});}
   commitAttempted=true;this.catalog.videos.tx(()=>{this.catalog.project(id,true);this.checkRoles(id,s);if(digest(this.catalog.folders.rows(id))!==s.folderStamp)fail('FOLDER_CONFLICT','执行期间目录资料发生变化，操作将回退',409);if(this.catalog.adoption(id).stamp!==s.adoptionStamp)fail('ADOPTION_CHANGED','执行期间采用镜号发生变化，操作将回退',409);for(const old of s.sourceRows)if((this.catalog.metadata(id,this.catalog.videos.source(id,old.id)).row?.revision||0)!==old.revision)fail('VIDEO_CONFLICT','执行期间资料发生变化，操作将回退',409);
    this.catalog.detachSources(id,[...new Set([...(s.sourceUnbindIds||[]),...s.removeIds])]);for(const key of s.removeIds){const old=s.sourceRows.find(r=>r.id===key),step=s.steps.find(x=>x.source===old?.path||x.kind==='trash'&&old&&within(x.source,old.path));const archived=step?.target?(step.kind==='trash'?path.join(step.target,path.relative(step.source,old.path)):step.target):undefined;this.catalog.retireRecord(id,key,archived);}
    for(const item of relocated)this.catalog.relocateRecord(id,this.catalog.videos.source(id,item.old.id),item.file,item.identity);
    if(s.input.kind==='delete-folder')this.catalog.folders.clearRemovedRole(id,[s.folderId,...nextFolders.filter(x=>!x.file).map(x=>x.row.id)]);
    for(const {row,file,identity}of nextFolders){const rel=file?path.relative(s.root,file).split(path.sep).join('/'):row.relativePath;const parent=file?s.folderRows.find(x=>this.mapped(s,path.join(s.root,...x.relativePath.split('/')))===path.dirname(file))?.id||'root':row.parentId;this.catalog.folders.write(id,row.id,this.catalog.folders.data(row,{name:file?path.basename(file):row.name,relativePath:rel,parentId:parent,identity:identity||row.identity,removedAt:file?0:Date.now()}));}
    completed={...s,unboundShotIds:s.plan.affectedShots.map(x=>x.id),status:'ready',resultFolderId:s.input.destinationFolderId||'root',error:null};this.save(id,requestId,completed);
   });s=completed;this.catalog.lib.onMetadataChanged?.(this.catalog.lib.roots().find(r=>within(r.path,s.root))?.id);
  }catch(e){
   if(commitAttempted){
    // IO rollback is safe only after reading the durable transaction outcome.
    // Never overwrite a committed READY receipt because its ACK was lost.
    try{const durable=this.row(id,requestId);if(durable.status==='ready')return this.dto(requestId,durable);}
    catch{return this.dto(requestId,{...s,status:'unknown',error:'文件操作落盘结果尚未核清，请查询原请求，未尝试回退'});}
   }
   s.error=e.message;s.status='running';s.unboundShotIds=[];delete s.resultFolderId;
   if(!s.steps.length&&!s.sourceDirectoryRemoved){s.status='failed';this.save(id,requestId,s);return this.dto(requestId,s);}try{await this.rollback(id,requestId,s);s.status='failed';}catch(rollback){s.status='unknown';s.error+='；回退未完成：'+rollback.message;}this.save(id,requestId,s);}return this.dto(requestId,s);}
 async rollback(id,requestId,s){if(s.status==='ready')fail('OPERATION_COMPLETED','已完成操作不能通过失败恢复重复执行',409);
  // Check the metadata BEFORE undoing bytes. A committed or later edited record
  // must not be stranded at a pathname that recovery has just removed.
  for(const old of s.sourceRows){const current=this.catalog.videos.source(id,old.id);if(current.path!==old.path||!equal(current.identity,old.identity)||(this.catalog.metadata(id,current).row?.revision||0)!==old.revision)fail('RECOVERY_CONFLICT','视频资料已提交或被后续修改，未移动回退文件',409);}
  const currentFolders=this.catalog.folders.rows(id);
  for(const old of s.folderRows){const file=path.join(s.root,...old.relativePath.split('/'));if(this.mapped(s,file)!==file||file===s.source&&s.sourceDirectoryRemoved){const current=currentFolders.find(x=>x.id===old.id);if(!current||!equal(current,old))fail('RECOVERY_CONFLICT','目录资料已提交或被后续修改，未移动回退文件',409);}}
  if(s.sourceDirectoryRemoved&&!await exists(s.source))await fs.mkdir(s.source,{mode:0o700});
  for(const step of [...s.steps].reverse()){const from=await exists(step.source),to=step.target?await exists(step.target):null;
   if(from&&!to){step.status='rolled-back';continue;}
   if(from&&to&&step.kind==='move'&&from.isFile()&&to.isFile()&&from.dev===to.dev&&from.ino===to.ino){await fs.unlink(step.target);step.status='rolled-back';continue;}
   if(from&&to&&to.isDirectory()&&step.reservation&&sameFolder(folderIdentity(to),step.reservation)&&(await fs.readdir(step.target)).length===0){await fs.rmdir(step.target);step.status='rolled-back';continue;}
   if(from||!to||String(to.dev)!==step.identity.dev||String(to.ino)!==step.identity.ino)fail('RECOVERY_CONFLICT','文件位置与操作回执不同，请保留现场并手动核对',409);
   if(to.isFile()&&(to.size!==step.identity.size||to.mtimeMs!==step.identity.mtimeMs))fail('RECOVERY_CONFLICT','移动后的文件已修改，未覆盖回退',409);
   await fs.rename(step.target,step.source);step.status='rolled-back';this.save(id,requestId,s);
  }
  const repair=[];for(const old of s.sourceRows){const current=this.catalog.videos.source(id,old.id);if(current.path!==old.path||(this.catalog.metadata(id,current).row?.revision||0)!==old.revision)fail('RECOVERY_CONFLICT','视频记录已被后续修改，未覆盖资料',409);const st=await exists(old.path);if(!st||String(st.dev)!==old.identity.dev||String(st.ino)!==old.identity.ino||st.size!==old.identity.size||st.mtimeMs!==old.identity.mtimeMs)fail('RECOVERY_CONFLICT','原视频尚未回到可确认的位置',409);repair.push({current,identity:stamp(st)});}
  const repairedFolders=[];for(const row of s.folderRows){const file=path.join(s.root,...row.relativePath.split('/'));if(this.mapped(s,file)!==file||file===s.source&&s.sourceDirectoryRemoved){const st=await fs.lstat(file);if(!st.isDirectory()||st.isSymbolicLink())fail('RECOVERY_CONFLICT','原目录尚未恢复',409);repairedFolders.push({row,identity:folderIdentity(st)});}}this.catalog.videos.tx(()=>{for(const item of repair)this.catalog.relocateRecord(id,item.current,item.current.path,item.identity);for(const item of repairedFolders)this.catalog.folders.write(id,item.row.id,this.catalog.folders.data(item.row,{identity:item.identity}));});
 }
 async recover(id, requestId, input) {
  if (input.action !== 'rollback') fail('INVALID_RECOVERY', '请选择回退原操作');
  return this.catalog.serial(async () => {
   const data = this.row(id, requestId);
   if (data.status === 'cancelled') fail(abandonedCode, abandonedMessage, 409);
   if (this.active.has(requestId)) fail('OPERATION_BUSY', '原操作仍在执行', 409);
   if (data.status === 'ready') return this.dto(requestId, data);
   if (data.input?.kind === 'move-videos' && data.status === 'preview') {
    fail('OPERATION_NOT_STARTED', '当前只有预览，没有需要回退的文件操作', 409);
   }
   await this.rollback(id, requestId, data);
   data.status = 'failed';
   data.error = '已回退原文件操作，请核对后重新整理';
   this.save(id, requestId, data);
   return this.dto(requestId, data);
  });
 }
}
