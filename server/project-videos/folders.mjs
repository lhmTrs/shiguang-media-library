import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical,idOK} from '../project-assets/model.mjs';
import {fail} from '../storyboard-video/model.mjs';
import {projectFolderName} from '../prompt-codex/pictures.mjs';
import {within} from '../fs-identity.mjs';

export const folderIdentity = st => ({dev:String(st.dev),ino:String(st.ino)});
export const sameFolder = (a,b) => !!a && !!b && a.dev===b.dev && a.ino===b.ino;
export const nameKey = name => name.normalize('NFC').toLowerCase();
export function folderName(value) {
  if(typeof value!=='string'||!value.trim()||value!==value.trim()||Buffer.byteLength(value)>240||/^[.]|[<>:"/\\|?*\x00-\x1f]|[. ]$/.test(value)||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(value))fail('INVALID_FOLDER_NAME','请输入有效文件夹名称，不能包含路径、保留名称或末尾空格');
  return value.normalize('NFC');
}
function relative(value) {return typeof value==='string' && value && !path.isAbsolute(value) && value.split('/').every(s=>{try{return folderName(s)===s;}catch{return false;}});}
export function validateFolderData(table,data) {
  if(!data||typeof data!=='object'||Array.isArray(data))fail('VIDEO_BACKUP_INVALID','项目视频目录资料无效');
  const keys=Object.keys(data).sort().join(',');
  if(table==='project_video_settings') {
    if(!['upgradeCompleted','rejectFolderId,upgradeCompleted'].includes(keys)||typeof data.upgradeCompleted!=='boolean'||Object.hasOwn(data,'rejectFolderId')&&data.rejectFolderId!==null&&!idOK(data.rejectFolderId))fail('VIDEO_BACKUP_INVALID','项目视频设置无效');
  } else if(table==='project_video_folders') {
    if(keys!=='identity,name,parentId,relativePath,removedAt'||folderName(data.name)!==data.name||!['root',null].includes(data.parentId)&&!idOK(data.parentId)||data.parentId===null||!relative(data.relativePath)||!Number.isSafeInteger(data.removedAt)||data.removedAt<0||!data.identity||Object.keys(data.identity).sort().join(',')!=='dev,ino'||typeof data.identity.dev!=='string'||typeof data.identity.ino!=='string')fail('VIDEO_BACKUP_INVALID','文件夹结构无效');
  } else fail('VIDEO_BACKUP_INVALID','未知视频目录资料');
  return data;
}

export class ProjectVideoFolders {
  constructor(catalog) {this.catalog=catalog;}
  get db(){return this.catalog.db;}
  settingsRow(id) {const row=this.db.prepare('SELECT * FROM project_video_settings WHERE id=?').get(id);if(row&&(row.project_id!==id||!Number.isSafeInteger(row.revision)||row.revision<1))fail('FOLDER_ROLES_CONFLICT','项目视频设置身份无效',409);return row;}
  settingsData(row) {return{rejectFolderId:null,...(row?validateFolderData('project_video_settings',JSON.parse(row.data_json)):{upgradeCompleted:false})};}
  settings(id) {return this.settingsData(this.settingsRow(id));}
  writeSettings(id,data,expectedRevision) {
    this.catalog.project(id,true);validateFolderData('project_video_settings',data);
    const row=this.settingsRow(id),now=Date.now();if((row?.revision||0)!==expectedRevision)fail('FOLDER_ROLES_CONFLICT','收纳角色或升级设置已变化，请重新预览',409);
    if(row){const result=this.db.prepare('UPDATE project_video_settings SET data_json=?,revision=?,updated_at=? WHERE id=? AND project_id=? AND revision=?').run(canonical(data),expectedRevision+1,now,id,id,expectedRevision);if(result.changes!==1)fail('FOLDER_ROLES_CONFLICT','项目视频设置已变化',409);}
    else {try{this.db.prepare('INSERT INTO project_video_settings VALUES(?,?,?,?,?,?)').run(id,id,canonical(data),1,now,now);}catch(e){if(['SQLITE_CONSTRAINT_PRIMARYKEY','SQLITE_CONSTRAINT_UNIQUE','ER_DUP_ENTRY'].includes(e.code))fail('FOLDER_ROLES_CONFLICT','项目视频设置已由另一操作创建，请重新预览',409);throw e;}}
  }
  completeUpgrade(id) {const row=this.settingsRow(id);this.writeSettings(id,{...this.settingsData(row),upgradeCompleted:true},row?.revision||0);}
  // These three helpers are synchronous: file operations call them inside their
  // existing metadata transaction, before any removed folder rows are written.
  inRejectArea(id,folderId,rows=this.rows(id)) {return this.inSubtree(folderId,this.settings(id).rejectFolderId,rows);}
  inSubtree(folderId,ancestorId,rows=[]) {
    if(!ancestorId)return false;const byId=new Map(rows.map(r=>[r.id,r]));
    const seen=new Set();while(folderId&&folderId!=='root'&&!seen.has(folderId)){if(folderId===ancestorId)return true;seen.add(folderId);const row=byId.get(folderId);if(!row)return false;folderId=row.parentId;}return false;
  }
  roleState(id) {
    this.catalog.project(id);const setting=this.settingsRow(id),revision=setting?.revision||0,rejectFolderId=this.settingsData(setting).rejectFolderId,rows=this.rows(id),byId=new Map(rows.map(r=>[r.id,r]));
    let current=rejectFolderId,needsReview=false;const seen=new Set();while(current&&current!=='root'){if(seen.has(current)||!byId.has(current)){needsReview=true;break;}seen.add(current);current=byId.get(current).parentId;}
    const rejectVideoCount=rejectFolderId?this.catalog.videos.sources(id).filter(s=>!this.catalog.metadata(id,s).data.removedAt&&this.inSubtree(this.folderId(id,s.path,rows),rejectFolderId,rows)).length:0;
    return{revision,rejectFolderId,rejectVideoCount,needsReview,...(needsReview?{errorCode:'REJECT_FOLDER_MISSING'}:{})};
  }
  clearRemovedRole(id,deletedFolderIds) {
    const state=this.roleState(id),deleted=new Set(deletedFolderIds),byId=new Map(this.rows(id).map(r=>[r.id,r]));let current=state.rejectFolderId;const seen=new Set();
    while(current&&current!=='root'&&!seen.has(current)){if(deleted.has(current)){this.writeSettings(id,{...this.settings(id),rejectFolderId:null},state.revision);return this.roleState(id);}seen.add(current);current=byId.get(current)?.parentId;}
    return state;
  }
  rows(id) {return this.db.prepare('SELECT * FROM project_video_folders WHERE project_id=? ORDER BY created_at,id').all(id).map(r=>({...r,...validateFolderData('project_video_folders',JSON.parse(r.data_json))})).filter(r=>!r.removedAt);}
  row(id,folderId) {if(!idOK(folderId))fail('FOLDER_NOT_FOUND','文件夹不存在',404);const row=this.rows(id).find(r=>r.id===folderId);if(!row)fail('FOLDER_NOT_FOUND','文件夹不属于当前项目或已删除',404);return row;}
  write(id,folderId,data) {validateFolderData('project_video_folders',data);const old=this.db.prepare('SELECT * FROM project_video_folders WHERE id=?').get(folderId),now=Date.now();if(old&&old.project_id!==id)fail('FOLDER_CONFLICT','文件夹归属不符',409);if(old)this.db.prepare('UPDATE project_video_folders SET data_json=?,revision=?,updated_at=? WHERE id=?').run(canonical(data),old.revision+1,now,folderId);else this.db.prepare('INSERT INTO project_video_folders VALUES(?,?,?,?,?,?)').run(folderId,id,canonical(data),1,now,now);}
  data(row,patch={}) {return{name:row.name,parentId:row.parentId,relativePath:row.relativePath,identity:row.identity,removedAt:row.removedAt,...patch};}
  async rootPath(id) {
    const p=this.catalog.project(id);let entries=[];
    try{entries=(await fs.readdir(this.catalog.directory,{withFileTypes:true})).filter(e=>e.isDirectory()&&e.name.endsWith('--'+id.toLowerCase()));}catch(e){if(e.code!=='ENOENT')throw e;}
    if(entries.length>1)fail('TARGET_CHANGED','当前项目存在多个视频根目录，请先核对',409);
    return path.join(this.catalog.directory,entries[0]?.name||projectFolderName(p));
  }
  rootForSource(id,file) {
    const parts=path.relative(this.catalog.directory,file).split(path.sep);
    return parts.length>=2&&!parts.includes('..')&&parts[0].endsWith('--'+id.toLowerCase())?path.join(this.catalog.directory,parts[0]):null;
  }
  folderId(id,file,rows=this.rows(id)) {const root=this.rootForSource(id,file);if(!root)return null;const rel=path.relative(root,path.dirname(file)).split(path.sep).join('/');return !rel?'root':rows.find(r=>r.relativePath===rel)?.id??null;}
  dto(row,root,roles=row.project_id?this.roleState(row.project_id):{rejectFolderId:null}) {return{id:row.id,parentId:row.parentId,name:row.name,path:path.join(root,...row.relativePath.split('/')),relativePath:row.relativePath,available:true,role:row.id===roles.rejectFolderId?'reject':null};}
  async resolve(id,folderId='root',{write=false,create=false}={}) {
    this.catalog.project(id,write);if(folderId==='all')folderId='root';
    const base=create?await this.catalog.prepareRoot(id):null,root=base?.target??await this.rootPath(id);
    const row=folderId==='root'?null:this.row(id,folderId),target=row?path.join(root,...row.relativePath.split('/')):root;
    if(!within(root,target))fail('INVALID_FOLDER','文件夹超出当前项目',403);
    const rootStat=await fs.lstat(root).catch(e=>{if(!write&&e.code==='ENOENT')return null;throw e;});
    if(!rootStat)return{projectPath:root,target,row,exists:false};
    if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||await fs.realpath(root)!==root||await fs.realpath(this.catalog.directory)!==this.catalog.directory)fail('TARGET_CHANGED','项目目录位置已变化或使用了符号链接',409);
    for(const part of path.relative(root,target).split(path.sep).filter(Boolean)) {
      // Full prefixes are checked below; no path supplied by the client is used.
      if(part==='..')fail('INVALID_FOLDER','目录越界',403);
    }
    let current=root;
    for(const part of path.relative(root,target).split(path.sep).filter(Boolean)) {current=path.join(current,part);const st=await fs.lstat(current);if(!st.isDirectory()||st.isSymbolicLink())fail('TARGET_CHANGED','文件夹不可用或包含符号链接',409);}
    const stat=await fs.lstat(target);if(row&&!sameFolder(folderIdentity(stat),row.identity))fail('TARGET_CHANGED','文件夹身份已变化，请刷新目录或重新定位',409);
    return{...base,projectPath:root,target,row,exists:true,rootStamp:folderIdentity(rootStat),targetIdentity:folderIdentity(stat),folderId};
  }
  async prepare(id,folderId='root') {const state=await this.resolve(id,folderId,{write:true,create:true});this.busyOperations(id,state.target);return{...state,projectTarget:state.projectPath,projectIdentity:state.rootStamp};}
  busyOperations(id,file,exceptId) {
    for(const r of this.db.prepare('SELECT * FROM project_video_operations WHERE project_id=?').all(id)) {
      if(r.id===exceptId)continue;const s=JSON.parse(r.data_json);
      if(!['running','unknown'].includes(s.status))continue;
      const paths=[s.file,s.source,...(s.moves||[]).flatMap(m=>[m.source,m.target])].filter(Boolean);
      if(paths.some(p=>within(file,p)||within(p,file)))fail('OPERATION_UNSETTLED','此位置有尚未结清的文件操作，请先核对原操作',409);
    }
  }
  busy(id,file,exceptId) {
    this.busyOperations(id,file,exceptId);
    for(const r of this.db.prepare('SELECT * FROM project_video_imports WHERE project_id=?').all(id)) {
      const s=JSON.parse(r.data_json);if(!['waiting','uploading','duplicate','running'].includes(s.status)||!s.state?.target)continue;
      if(within(file,s.state.target))fail('FOLDER_BUSY','此目录仍有视频正在导入，请等待原任务结束后再整理',409);
    }
  }
  async intakeChild(id,parentId,value) {
    const name=folderName(value),parent=await this.resolve(id,parentId);
    if(!parent.exists&&parentId!=='root')fail('FOLDER_NOT_FOUND','父文件夹已不存在',404);
    const rows=this.rows(id).filter(row=>row.parentId===parentId&&nameKey(row.name)===nameKey(name));
    const entries=parent.exists?(await fs.readdir(parent.target)).filter(entry=>nameKey(entry)===nameKey(name)):[];
    const checked=await this.resolve(id,parentId);
    if(parent.target!==checked.target||parent.exists!==checked.exists||
      parent.exists&&!sameFolder(parent.targetIdentity,checked.targetIdentity))fail('TARGET_CHANGED','父文件夹已变化',409);
    if(rows.length||entries.length){
      if(rows.length!==1||entries.length!==1)fail('FOLDER_EXISTS','同名项未登记为可用的项目视频文件夹',409);
      const state=await this.resolve(id,rows[0].id);
      if(!state.exists||path.dirname(state.target)!==parent.target||nameKey(path.basename(state.target))!==nameKey(entries[0]))
        fail('TARGET_CHANGED','同名文件夹已移动或替换',409);
      return {parent,state};
    }
    const relativePath=[parent.row?.relativePath,name].filter(Boolean).join('/');
    return {parent,state:{target:path.join(parent.target,name),row:{name,relativePath},exists:false}};
  }
  async create(id,input,{beforeCreate}={}) {
    this.catalog.project(id,true);const requestId=input.requestId;if(!idOK(requestId))fail('INVALID_REQUEST_ID','新建文件夹请求编号无效');
    const previous=this.db.prepare('SELECT * FROM project_video_operations WHERE id=?').get(requestId);
    const args=canonical({parentId:input.parentId||'root',name:folderName(input.name)});
    if(previous){const p=JSON.parse(previous.data_json);if(previous.project_id!==id||p.args!==args)fail('REQUEST_ID_CONFLICT','请求编号已用于其他目录',409);if(p.status==='ready')return p.folder;fail('OPERATION_UNSETTLED','原新建目录操作尚未结清，请核对原请求',409);}
    return this.catalog.serial(async()=>{
      const replay=this.db.prepare('SELECT * FROM project_video_operations WHERE id=?').get(requestId);if(replay){const x=JSON.parse(replay.data_json);if(replay.project_id===id&&x.args===args&&x.status==='ready')return x.folder;fail('OPERATION_UNSETTLED','原新建目录请求仍需核对',409);}
      const parentProof=await beforeCreate?.();
      const state=await this.resolve(id,input.parentId||'root',{write:true,create:true}),name=folderName(input.name),file=path.join(state.target,name);
      if(parentProof&&(parentProof.target!==state.target||parentProof.exists&&!sameFolder(parentProof.targetIdentity,state.targetIdentity)))
        fail('TARGET_CHANGED','父文件夹已变化',409);
      this.busyOperations(id,state.target);const names=await fs.readdir(state.target);if(names.some(n=>nameKey(n)===nameKey(name)))fail('FOLDER_EXISTS','同级文件夹或文件名称已存在，请使用其他名称',409);
      const folderId=randomUUID(),now=Date.now(),record={kind:'create-folder',args,status:'running',file};this.db.prepare('INSERT INTO project_video_operations VALUES(?,?,?,?,?)').run(requestId,id,canonical(record),now,now);
      let createdIdentity=null;
      try {
        await this.catalog.current(id,state);await fs.mkdir(file,{mode:0o700});const st=await fs.lstat(file);
        if(!st.isDirectory()||st.isSymbolicLink()||await fs.realpath(file)!==file)fail('TARGET_CHANGED','新建目录身份已变化',409);
        createdIdentity=folderIdentity(st);record.createdIdentity=createdIdentity;
        const data={name,parentId:input.parentId||'root',relativePath:path.relative(state.projectPath,file).split(path.sep).join('/'),identity:folderIdentity(st),removedAt:0};
        const folder=this.dto({id:folderId,...data},state.projectPath);this.catalog.videos.tx(()=>{this.write(id,folderId,data);this.db.prepare('UPDATE project_video_operations SET data_json=?,updated_at=? WHERE id=?').run(canonical({...record,status:'ready',folder}),Date.now(),requestId);});return folder;
      }catch(e){let status='unknown',error=e.message;try{const st=await fs.lstat(file).catch(x=>x.code==='ENOENT'?null:Promise.reject(x));if(!st)status='failed';else if(createdIdentity&&st.isDirectory()&&!st.isSymbolicLink()&&sameFolder(folderIdentity(st),createdIdentity)&&(await fs.readdir(file)).length===0){await fs.rmdir(file);status='failed';}}catch(rollback){error+='；新建目录回退待核对：'+rollback.message;}this.db.prepare('UPDATE project_video_operations SET data_json=?,updated_at=? WHERE id=?').run(canonical({...record,status,error}),Date.now(),requestId);throw e;}
    });
  }
  async refresh(id,folderId='root') {
    return this.catalog.serial(async()=>{
      const state=await this.resolve(id,folderId,{write:true,create:true}),rows=this.rows(id),entries=await fs.readdir(state.target,{withFileTypes:true});
      this.busy(id,state.target);
      for(const entry of entries) {
        if(!entry.isDirectory()||entry.isSymbolicLink()||entry.name.startsWith('.'))continue;
        try{folderName(entry.name);}catch{continue;}
        const file=path.join(state.target,entry.name),st=await fs.lstat(file),identity=folderIdentity(st),rel=path.relative(state.projectPath,file).split(path.sep).join('/');
        const exact=rows.find(r=>r.relativePath===rel),matches=rows.filter(r=>sameFolder(r.identity,identity));
        if(exact&&!sameFolder(exact.identity,identity))continue; // Never grant an old ID to a replaced directory.
        if(matches.length>1)continue;
        const known=exact||matches[0];
        if(known&&known.relativePath!==rel){const old=known.relativePath;this.catalog.videos.tx(()=>{for(const r of rows.filter(r=>r.relativePath===old||r.relativePath.startsWith(old+'/')))this.write(id,r.id,this.data(r,{relativePath:rel+r.relativePath.slice(old.length),...(r.id===known.id?{name:entry.name,parentId:folderId}:{} )}));});}
        else if(!known)this.catalog.videos.tx(()=>this.write(id,randomUUID(),{name:entry.name,parentId:folderId,relativePath:rel,identity,removedAt:0}));
      }
      // Explicit current-layer refresh may prove a moved file by its retained inode and content.
      const sources=this.catalog.videos.sources(id).filter(s=>this.catalog.videos.authorized(s)&&!this.catalog.metadata(id,s).data.removedAt);
      for(const entry of entries.filter(e=>e.isFile()&&!e.name.startsWith('.'))) {
        const file=path.join(state.target,entry.name),st=await fs.lstat(file);if(sources.some(s=>s.path===file))continue;
        const matches=sources.filter(s=>s.identity.dev===String(st.dev)&&s.identity.ino===String(st.ino)&&s.identity.size===st.size);
        if(matches.length!==1)continue;const source=matches[0],meta=this.catalog.metadata(id,source).data;
        if(!meta.managed||!meta.sha256)continue;
        const old=await fs.lstat(source.path).catch(e=>e.code==='ENOENT'?null:Promise.reject(e));if(old)continue;
        const checked=await this.catalog.hash(file);if(checked.hash!==meta.sha256)continue;
        this.catalog.videos.tx(()=>this.catalog.relocateRecord(id,source,file,checked.identity));
      }
      return{ok:true};
    });
  }
}
