import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical,idOK} from '../project-assets/model.mjs';
import {usageFail as fail} from './action-journal.mjs';
import {folderIdentity,sameFolder,nameKey} from './folders.mjs';

const conflict=(kind)=>fail('FINAL_FOLDER_NAME_CONFLICT','同名位置不是可接管的普通文件夹',409,{conflictKind:kind,canAdopt:false});
export class ProjectVideoFinalFolder {
 constructor(catalog){this.catalog=catalog;}
 get c(){return this.catalog;}
 async roles(id){
  const c=this.c,db=c.db,state=c.folders.roleState(id);
  if(state.rejectFolderId&&!state.needsReview){try{const role=await c.folders.resolve(id,state.rejectFolderId);if(!role.exists)throw Object.assign(Error(),{code:'ENOENT'});}catch(e){state.needsReview=true;state.errorCode=e.code==='ENOENT'||e.code==='FOLDER_NOT_FOUND'?'REJECT_FOLDER_MISSING':'REJECT_FOLDER_CHANGED';}}
  if(state.finalFolderId){
   try{const row=c.folders.row(id,state.finalFolderId);if(row.parentId!=='root'||row.name!=='成片'||row.relativePath!=='成片'||c.folders.inRejectArea(id,row.id))throw Error('role');const p=await c.folders.resolve(id,row.id);if(!p.exists)throw Error('missing');state.finalState='ready';state.finalErrorCode=null;}
   catch{state.finalState='needs_review';state.finalErrorCode='FINAL_FOLDER_NEEDS_REVIEW';}
  }
  if(db!==c.db)fail('LOCAL_INSTANCE_CHANGED','素材库实例已变化',409);return state;
 }
 async preview(id){
  const c=this.c,db=c.db,roles=await this.roles(id),rows=c.folders.rows(id);
  if(roles.finalFolderId){
   if(roles.finalState!=='ready')fail('FINAL_FOLDER_NEEDS_REVIEW','已登记的成片文件夹位置或身份发生变化，请先核对',409,{folderId:roles.finalFolderId,state:'needs_review'});
   const state=await c.folders.resolve(id,roles.finalFolderId);return{roles,state,outcome:'existing'};
  }
  const parent=await c.folders.resolve(id,'root'),entries=parent.exists?(await fs.readdir(parent.target)).filter(n=>nameKey(n)===nameKey('成片')):[];
  const candidates=rows.filter(r=>r.parentId==='root'&&nameKey(r.name)===nameKey('成片'));
  if(entries.length>1||candidates.length>1)conflict('multiple');
  let row=candidates[0],identity=null,name=entries[0]||'成片',target=path.join(parent.target,name);
  if(entries.length){
   const st=await fs.lstat(target);if(st.isSymbolicLink())conflict('symbolic-link');if(!st.isDirectory())conflict('file');if(await fs.realpath(target)!==target)conflict('untrusted');
   await fs.access(target,fs.constants.R_OK|fs.constants.W_OK|fs.constants.X_OK);identity=folderIdentity(st);
   if(name!=='成片')conflict('noncanonical-name');
   const matches=rows.filter(r=>sameFolder(r.identity,identity));
   if(row&&(!sameFolder(row.identity,identity)||row.relativePath!==name)||matches.some(r=>r.id!==row?.id))conflict('identity');
   if(row&&(c.folders.inRejectArea(id,row.id,rows)||c.folders.inSubtree(roles.rejectFolderId,row.id,rows)))conflict('reserved-role');
  }else if(row)conflict('registered-missing');
  if(c.db!==db)fail('LOCAL_INSTANCE_CHANGED','素材库实例已变化',409);
  return{roles,parent,state:{target,row:row??{name:'成片',parentId:'root',relativePath:'成片'},exists:entries.length===1,targetIdentity:identity},outcome:entries.length?'adopted':'created'};
 }
 ensure(id,input){
  this.c.project(id);if(!input||!idOK(input.requestId))fail('INVALID_REQUEST_ID','请求编号无效');
  if(Object.keys(input).some(k=>!['requestId','expectedRolesRevision'].includes(k))||!Number.isSafeInteger(input.expectedRolesRevision)||input.expectedRolesRevision<0)fail('INVALID_INPUT','请提供目录角色修订号');
  const c=this.c,j=c.usageJournal;
  return j.start(id,null,'final-folder-ensure',input,'final',async s=>{
   j.guard(s);let plan=await this.preview(id);j.guard(s);
   if(plan.roles.revision!==input.expectedRolesRevision)fail('FOLDER_ROLES_CONFLICT','收纳角色已变化，请重新读取',409);
   if(plan.outcome==='existing'){
    c.videos.tx(()=>{j.guard(s);j.complete(s,{outcome:'existing',folder:this.dto(plan.state.row,plan.roles),folderRoles:plan.roles,created:false,adopted:false,contentsMoved:false});});return;
   }
   // Durable intent precedes every possible mkdir. An interrupted request is
   // query-only and blocks replacement requests, including after a restart.
   if(!plan.parent.exists){s.status='running';s.dispatched=true;s.file=plan.state.target;j.save(s);}
   const root=await c.prepareRoot(id);j.guard(s);await c.current(id,root);j.guard(s);
   const current=await this.preview(id);j.guard(s);
   if(current.roles.revision!==input.expectedRolesRevision||current.outcome!==plan.outcome||current.state.target!==plan.state.target||canonical(current.state.targetIdentity)!==canonical(plan.state.targetIdentity)||plan.parent.exists&&!sameFolder(current.parent.targetIdentity,plan.parent.targetIdentity))fail('FOLDER_ROLES_CONFLICT','目录或角色在准备期间变化',409);
   plan=current;c.folders.busy(id,plan.state.target,input.requestId);j.assertSettled(id,'final',input.requestId);
   let identity=plan.state.targetIdentity;
   if(plan.outcome==='created'){
    s.status='running';s.dispatched=true;s.file=plan.state.target;j.save(s);await c.current(id,root);j.guard(s);
    await fs.mkdir(plan.state.target,{mode:0o700});j.guard(s);
    const st=await fs.lstat(plan.state.target);if(!st.isDirectory()||st.isSymbolicLink()||await fs.realpath(plan.state.target)!==plan.state.target)conflict('identity');identity=folderIdentity(st);
   }
   await c.current(id,root);j.guard(s);const after=await fs.lstat(plan.state.target);j.guard(s);
   if(!after.isDirectory()||after.isSymbolicLink()||!sameFolder(folderIdentity(after),identity))conflict('identity');
   const folderId=plan.state.row.id||randomUUID(),data={name:'成片',parentId:'root',relativePath:'成片',identity,removedAt:0};
   c.videos.tx(()=>{
    j.guard(s);c.project(id,true);if(c.folders.roleState(id).revision!==input.expectedRolesRevision)fail('FOLDER_ROLES_CONFLICT','收纳角色在确认期间变化',409);
    if(!plan.state.row.id)c.folders.write(id,folderId,data);
    c.folders.writeSettings(id,{...c.folders.settings(id),finalFolderId:folderId},input.expectedRolesRevision);
    const folderRoles=c.folders.roleState(id);j.complete(s,{outcome:plan.outcome,folder:this.dto({id:folderId,...data},folderRoles),folderRoles,created:plan.outcome==='created',adopted:plan.outcome==='adopted',contentsMoved:false});
   });
  });
 }
 dto(row,roles){return{id:row.id,parentId:row.parentId,name:row.name,relativePath:row.relativePath,role:'final',locked:true,available:roles.finalState==='ready'};}
 async ensureResolved(id,input){
  let result=await this.ensure(id,input);if(['checking','running'].includes(result.status)){await this.c.usageJournal.active.get(input.requestId);result=this.c.usageJournal.dto(this.c.usageJournal.row(id,input.requestId));}
  if(result.status!=='completed')fail(result.error?.code||'FINAL_FOLDER_OPERATION_UNSETTLED',result.error?.message||'原目录操作结果尚未核清，请查询原请求',409,{requestId:input.requestId,statusUrl:result.statusUrl});
  return result.result;
 }
}
