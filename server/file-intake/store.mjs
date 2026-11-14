import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {Receipts,uuid,stamp,same,unchanged,revalidateSelection,error} from './files.mjs';

import {defaultRoutingPreferences} from './preferences.mjs';
import {IntakeNames,checkChoice,wantsStandard} from './names.mjs';
import {folderName,nameKey,sameFolder} from '../project-videos/folders.mjs';

const stable = value => JSON.stringify(value);
const pending = new Set(['queued','copying','duplicate','unknown']);
const terminal = new Set(['ready','managed','failed','cancelled','source_retained']);
const unavailableVideoFolder = new Set(['ENOENT','ENOTDIR','FOLDER_NOT_FOUND','TARGET_CHANGED']);
const desktopUnavailable=new Set(['APPLICATION_CLOSING','DESKTOP_PLATFORM_UNAVAILABLE','DESKTOP_SESSION_UNAVAILABLE','NATIVE_HELPER_UNAVAILABLE','NATIVE_COMPILER_UNAVAILABLE']);
const videoFolderChanged = () => error('TARGET_CHANGED','所选项目视频文件夹已移动、删除或变化，请重新选择');
const folderView = row => ({id:row.id,name:row.name,relativePath:row.relativePath});
const sameDirectoryState = (a,b) => a.target===b.target&&a.exists===b.exists&&(!a.exists||sameFolder(a.targetIdentity,b.targetIdentity));
function folderRequestId(batchId,projectId,parentId,name) {
  const hash=createHash('sha256').update(stable(['intake-folder',batchId,projectId,parentId,nameKey(name)])).digest('hex');
  return [hash.slice(0,8),hash.slice(8,12),'5'+hash.slice(13,16),'8'+hash.slice(17,20),hash.slice(20,32)].join('-');
}
const publicItem = i => ({id:i.id,name:i.name,bytes:i.bytes,copiedBytes:i.copiedBytes||0,status:i.status,
  error:i.error,code:i.code,videoId:i.videoId,assetId:i.assetId,managedProjectId:i.managedProjectId,
  managedProjectName:i.managedProjectName,destination:i.destination,resolvedFolder:i.resolvedFolder,reveal:i.reveal,nameMode:i.nameMode,plannedFileName:i.plannedFileName,resultFileName:i.resultFileName,destinationLabel:i.destinationLabel,creativeAssetId:i.creativeAssetId,lookId:i.lookId,bindingId:i.bindingId,mediaKind:i.mediaKind,adoptionStamp:i.adoptionStamp,candidates:i.candidates});

export class FileIntake {
  constructor({dataDir,catalog,projects,withActivity=fn=>fn(),trash,libraryId=dataDir,generic,preferences,desktop=catalog.desktopNative}) {
    this.desktop=desktop;this.receiptSessions=new Map();this.folderDispatches=new Map();this.liveReveal=new Set();
    this.generic=generic;this.preferences=preferences;this.receipts=new Receipts(dataDir);this.catalog=catalog;this.projects=projects;
    this.withActivity=withActivity;this.trash=trash||((file,expected)=>this.boundTrash(file,expected));
    this.canTrash=!!(trash||catalog.lib.trashBin);this.batches=new Map();this.foreignIds=new Set();this.closing=false;this.finalizing=new Set();
    this.operation=Promise.resolve();this.writes=Promise.resolve();this.work=null;this.instance=randomUUID();this.timer=null;this.libraryId=libraryId;
  }
  async init() {
    try {
    await this.receipts.init();
    for(let b of await this.receipts.list('batches',{tolerateInvalid:true})) {
      if(b.invalid||!uuid(b.id)||!Array.isArray(b.items)) {
        b={id:b.id,invalid:true,status:'interrupted',projectId:'',projectName:'回执待核对',folderId:'',folderName:'原目标待核对',mode:'copy',createdAt:0,updatedAt:0,
          items:[{id:b.id,name:'文件任务回执不可读',bytes:0,status:'unknown',error:'原回执保留，未自动重发或移除原文件'}]};
        this.batches.set(b.id,b);continue;
      }
      // A shared journal location does not make another library's receipts ours.
      // Leave foreign bytes untouched and out of the active library's task list.
      if(b.libraryId!==this.libraryId){this.foreignIds.add(b.id);continue;}
      let removalInterrupted=false;
      for(const i of b.items)if(b.mode==='move'&&i.status==='ready'&&i.removal!=='complete') {
        i.status=i.removal==='planned'?'unknown':'source_retained';
        i.error='上次原件移除结果尚未确认；副本与原回执保留，不自动再次移除';removalInterrupted=true;
      }
      let revealInterrupted=false;
      for(const i of b.items)if(i.revealAttemptedAt&&!i.reveal){
        i.reveal={status:'unknown',at:i.revealAttemptedAt,error:{code:'INTAKE_DESKTOP_UNKNOWN',message:'上次访达显示结果待核对'}};
        revealInterrupted=true;
      }
      if(removalInterrupted||b.items.some(i=>pending.has(i.status))) {
        b.status='interrupted';
        for(const i of b.items)if(['queued','copying'].includes(i.status)) {
          i.status='unknown';i.error='上次运行中断，请核对原回执；尚未自动重发或移除原文件';
        }
        await this.receipts.write('batches',b.id,b);
      } else if(['running','queued'].includes(b.status)) {
        // Registration was durable before the last batch summary was saved.
        // Recover that receipt only; old temporary files are never swept here.
        this.summarize(b);await this.receipts.write('batches',b.id,b);
      }
      else if(revealInterrupted)await this.receipts.write('batches',b.id,b);
      this.batches.set(b.id,b);
    }
    }catch(e){this.initializationError=error('INTAKE_STORAGE_UNAVAILABLE','文件任务存储不可用，未开始收纳；原件与原回执保留。请检查本机数据目录权限');}
    return this;
  }
  serial(fn) {const work=this.operation.then(fn);this.operation=work.catch(()=>{});return work;}
  assertOpen(){if(this.initializationError)throw this.initializationError;if(this.closing)throw error('APPLICATION_CLOSING','服务正在关闭，已确认的文件任务保留',503);}
  assertLibrary(b){if(b.invalid)throw error('INTAKE_RECEIPT_INVALID','文件任务回执不可读，原件与原回执保留，不能自动继续');if(b.libraryId!==this.libraryId)throw error('LOCAL_INSTANCE_CHANGED','这批文件任务属于另一素材库实例，未继续或移除原文件');}
  resultKey(b) {return createHash('sha256').update(stable({libraryId:b.libraryId,projectId:b.projectId,folderId:b.folderId,targets:b.version===2?b.items.map(i=>[i.id,i.destination]):undefined,mode:b.mode,status:b.status,
    items:b.items.map(i=>[i.id,i.status,i.requestId,i.code,i.error,i.videoId,i.assetId,i.copiedBytes,i.removal])})).digest('hex');}
  canAcknowledge(b) {return !b.invalid&&b.libraryId===this.libraryId&&['completed','partial','interrupted'].includes(b.status)&&b.items.length>0&&
    b.items.every(i=>terminal.has(i.status)&&i.removal!=='planned'&&!this.finalizing.has(i.id));}
  acknowledged(b) {return this.canAcknowledge(b)&&b.acknowledgment?.resultKey===this.resultKey(b);}
  dto(b) {return {version:b.version,id:b.id,projectId:b.projectId,projectName:b.projectName,folderId:b.folderId,folderName:b.folderName,
    mode:b.mode,createdAt:b.createdAt,updatedAt:b.updatedAt,status:b.status,
    canAcknowledge:this.canAcknowledge(b),acknowledged:this.acknowledged(b),acknowledgedAt:this.acknowledged(b)?b.acknowledgment.at:undefined,resultKey:this.resultKey(b),items:b.items.map(i=>({...publicItem(i),status:this.finalizing.has(i.id)?'copying':i.status}))};}
  batch(id) {if(this.foreignIds.has(id))throw error('LOCAL_INSTANCE_CHANGED','这批文件任务属于另一素材库，原回执保留');if(!uuid(id)||!this.batches.has(id))throw error('INTAKE_NOT_FOUND','文件任务不存在',404);return this.batches.get(id);}
  list(){return {batches:[...this.batches.values()].sort((a,b)=>b.createdAt-a.createdAt).slice(0,50).map(b=>this.dto(b))};}
  status(){const all=[...this.batches.values()],items=all.flatMap(b=>b.items);
    const last=all.filter(b=>['completed','partial'].includes(b.status)).sort((a,b)=>b.updatedAt-a.updatedAt)[0];return {
    canTrash:this.canTrash,activeCount:items.filter(i=>['queued','copying'].includes(i.status)||this.finalizing.has(i.id)).length,
    needsAttention:all.filter(b=>!this.acknowledged(b)).flatMap(b=>b.items).filter(i=>['duplicate','failed','source_retained','unknown'].includes(i.status)).length,
    latestCompletion:last?{id:last.id,updatedAt:last.updatedAt,projectName:last.projectName,status:last.status,
      completed:last.items.filter(i=>['ready','managed'].includes(i.status)).length,
      failed:last.items.filter(i=>i.status==='failed').length,retained:last.items.filter(i=>i.status==='source_retained').length}:null};}
  async save(b,{touch=true}={}) {if(touch)b.updatedAt=Date.now();const snapshot=structuredClone(b);
    const work=this.writes.then(()=>this.receipts.write('batches',b.id,snapshot));this.writes=work.catch(()=>{});return work;}
  async acknowledge(id,input={}) {return this.serial(async()=>{
    this.assertOpen();const b=this.batch(id);this.assertLibrary(b);
    if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.acknowledged!=='boolean')
      throw error('INTAKE_INVALID_INPUT','请选择标记已处理或恢复待处理',400);
    if(!this.canAcknowledge(b))throw error('INTAKE_NOT_SETTLED','任务仍在运行或结果待核对，不能标记已处理',409);
    if(input.resultKey!==this.resultKey(b))throw error('INTAKE_RESULT_CHANGED','任务结果已变化，请重新读取后确认',409);
    const next=structuredClone(b);
    if(input.acknowledged)next.acknowledgment={at:Date.now(),resultKey:input.resultKey};
    else delete next.acknowledgment;
    // A read acknowledgment never rewrites the business result or completion time.
    // Publish it in memory only after its receipt is durable.
    await this.save(next,{touch:false});b.acknowledgment=next.acknowledgment;return this.dto(b);
  });}
  async handoff(id) {
    const h=await this.receipts.read('handoffs',id);
    const b=[...this.batches.values()].find(b=>b.handoffId===id);
    const projects=this.projects.list();
    const {targets,routingPreferences}=await this.intakePreferences(projects);
    return {id:h.id,files:h.files.map(({id,name,bytes,path,mediaKind,durationSec})=>({id,name,bytes,path,mediaKind:mediaKind||'video',
        ...(mediaKind==='audio'?{durationSec:durationSec??null}:{})})),
      projects:projects.filter(p=>!p.archived).map(({id,name})=>({id,name})),canTrash:this.canTrash,batchId:b?.id,
      preparation:h.preparation,preparationError:h.preparationError,preferences:targets,routingPreferences,themeId:this.preferences?.themeId??null};
  }
  async intakePreferences(projects=this.projects.list()) {
    if(!this.preferences)return {targets:{},routingPreferences:defaultRoutingPreferences()};
    const snapshot=this.preferences.snapshot(projects);
    const folders=snapshot.routingPreferences.lastVideoFolderByProject;
    const target=snapshot.targets.video;
    const sharedFolder=target?.scope==='project'&&folders[target.projectId]===target.folderId;
    for(const [projectId,folderId] of Object.entries(folders))
      if(folderId!=='root'&&!await this.availableVideoFolder(projectId,folderId))folders[projectId]='root';
    if(sharedFolder)target.folderId=folders[target.projectId];
    else if(target?.scope==='project' && target.folderId!=='root' &&
        !await this.availableVideoFolder(target.projectId,target.folderId))target.folderId='root';
    return snapshot;
  }
  projectSeries(id) {
    const store=this.projects.series,member=store?.membership(id);
    if(!member?.series_id)return undefined;
    const series=store.series(member.series_id),season=member.season_id?store.season(series.id,member.season_id):null;
    return {id:series.id,name:series.name,seasonNo:season?Number(season.season_no):null,
      seasonLabel:season?.label??null,episodeNo:member.episode_no};
  }
  async routingOptions(){
    const {folders:photoCategories}=await this.generic.choices('photo','',{readOnly:true});
    const db=this.generic.db,assets=db.prepare('SELECT id,kind,name,revision,default_look_id FROM creative_assets WHERE project_id=? AND archived_at=0 ORDER BY name,id');
    const looks=db.prepare('SELECT l.id,l.asset_id,l.data_json,l.revision FROM creative_looks l JOIN creative_assets a ON a.id=l.asset_id WHERE a.project_id=? AND a.archived_at=0 AND l.archived_at IS NULL ORDER BY l.sort_order,l.id');
    const projects=[];
    for(const {id,name} of this.projects.list().filter(p=>!p.archived)){
      const {folders:videoFolders}=await this.folders(id),byAsset=new Map();
      for(const row of looks.all(id)){
        const group=byAsset.get(row.asset_id)??[];
        group.push({id:row.id,name:JSON.parse(row.data_json).name,revision:row.revision});byAsset.set(row.asset_id,group);
      }
      const series=this.projectSeries(id);
      projects.push({id,name,...(series?{series}:{}),videoFolders,assets:assets.all(id).map(({default_look_id,...a})=>({
        ...a,defaultLookId:default_look_id??null,looks:byAsset.get(a.id)??[],
      }))});
    }
    return {projects,photoCategories};
  }
  namePlanner() {
    const reservations=[];
    for(const b of this.batches.values())for(const i of b.items)if(pending.has(i.status))
      reservations.push([(i.target??b.target)?.target,i.plannedFileName??i.destination?.fileName??i.name]);
    return new IntakeNames(reservations);
  }
  async videoNameTarget(destination,{write=false}={}) {
    const project=this.catalog.project(destination.projectId,write),parentId=destination.folderId??'root';
    const name=destination.newFolder?folderName(destination.newFolder.name):null;
    if(name&&parentId!=='root'&&!uuid(parentId))throw error('INTAKE_INVALID_INPUT','请选择有效的父文件夹',400);
    const read=async()=>{
      if(!name)return {state:await this.resolveVideoFolder(project.id,parentId)};
      try{return await this.catalog.folders.intakeChild(project.id,parentId,name);}
      catch(e){if(unavailableVideoFolder.has(e.code))throw videoFolderChanged();throw e;}
    };
    const {state,parent}=await read(),series=this.projectSeries(project.id);
    return {project,series,folder:state.row,directory:state.target,state,parent,name,parentId,verify:async()=>{
      const checked=await read();
      if(!sameDirectoryState(state,checked.state)||parent&&!sameDirectoryState(parent,checked.parent))
        throw videoFolderChanged();
    }};
  }
  async previewNameTarget(destination,options) {
    if(destination.scope==='library'){
      const state=await this.generic.previewLibraryTarget(destination);
      return {directory:state.target,verify:state.verify};
    }
    if(destination.kind==='video')return this.videoNameTarget(destination,options);
    const state=await this.generic.previewImageTarget(destination);
    return {directory:state.target,assetName:state.assetName,verify:state.verify};
  }
  async resolveNewIntakeFolder(ctx,batchId) {
    const {project,parent,parentId,name,state}=ctx;
    if(state.exists){
      await ctx.verify();
      return {folder:folderView(state.row),state,parent};
    }
    const folders=this.catalog.folders;
    const read=async()=>{
      const checked=await folders.intakeChild(project.id,parentId,name);
      if(!sameDirectoryState(parent,checked.parent))throw videoFolderChanged();
      return checked;
    };
    const existing=await read();
    if(existing.state.exists)return {folder:folderView(existing.state.row),...existing};
    try {
      const created=await folders.create(project.id,{requestId:folderRequestId(batchId,project.id,parentId,name),parentId,name},{
        beforeCreate:async()=>{
          const checked=await read();
          if(checked.state.exists)throw error('FOLDER_EXISTS','同级文件夹已建立');
          return checked.parent;
        },
      });
      const checked=await folders.intakeChild(project.id,parentId,name);
      if(checked.state.row?.id!==created.id||parent.exists&&!sameDirectoryState(parent,checked.parent))throw videoFolderChanged();
      return {folder:folderView(checked.state.row),...checked};
    } catch(e) {
      if(e.code!=='FOLDER_EXISTS')throw e;
      const checked=await read();
      if(!checked.state.exists)throw e;
      return {folder:folderView(checked.state.row),...checked};
    }
  }
  async namePreview(id,input) {
    this.assertOpen();
    const h=await this.receipts.read('handoffs',id),files=new Map(h.files.map(f=>[f.id,f]));
    if(!Array.isArray(input?.targets)||input.targets.length>h.files.length||input.targets.some(t=>!t||!files.has(t.fileId))||
        new Set(input.targets.map(t=>t.fileId)).size!==input.targets.length)
      throw error('INTAKE_INVALID_INPUT','文件清单与目标不匹配',400);
    const planner=this.namePlanner(),rows=[],children=new Map();
    for(const target of input.targets){
      const f=files.get(target.fileId),result={fileId:f.id,proposedFileName:null,proposedNumber:null};
      try {
        checkChoice(f,target);
        const {destination,nameMode}=target,ctx={destination,nameMode,...await this.planningTarget(destination,children)};
        if(!wantsStandard(ctx.destination,ctx.nameMode))planner.reserve(ctx.directory,ctx.destination.fileName??f.name);
        rows.push({f,ctx,result});
      }catch(e){rows.push({result:{...result,error:this.namePreviewError(e)}});}
    }
    for(const row of rows)if(row.ctx)try{Object.assign(row.result,await planner.plan(row.f,row.ctx));}
    catch(e){row.result.error=this.namePreviewError(e);}
    return {items:rows.map(row=>row.result)};
  }
  async planningTarget(destination,children,options) {
    if(!destination.newFolder)return this.previewNameTarget(destination,options);
    const key=stable([destination.projectId,destination.folderId??'root',nameKey(folderName(destination.newFolder.name))]);
    if(!children.has(key))children.set(key,await this.videoNameTarget(destination,options));
    return children.get(key);
  }
  namePreviewError(e) {
    return e.status?{code:e.code||'TARGET_CHANGED',message:e.message}:{code:'TARGET_CHANGED',message:'未能读取目标目录，请刷新目标后重试'};
  }
  async resolveVideoFolder(projectId,folderId) {
    let state;
    try {
      state=await this.catalog.folders.resolve(projectId,folderId);
    }catch(e){
      if(unavailableVideoFolder.has(e.code))throw videoFolderChanged();
      throw e;
    }
    if(folderId!=='root'&&(!state.exists||!state.row))throw videoFolderChanged();
    return state;
  }
  async availableVideoFolder(projectId,folderId) {
    try{return await this.resolveVideoFolder(projectId,folderId);}
    catch(e){if(e.code==='TARGET_CHANGED')return null;throw e;}
  }
  async prepareVideoFolder(projectId,folderId) {
    if(folderId!=='root')await this.resolveVideoFolder(projectId,folderId);
    try{return await this.catalog.prepare(projectId,folderId);}
    catch(e){if(unavailableVideoFolder.has(e.code))throw videoFolderChanged();throw e;}
  }
  async folders(projectId) {
    this.catalog.project(projectId);
    const folders=[{id:'root',name:'项目根目录',relativePath:''}];
    for(const {id} of this.catalog.folders.rows(projectId)){
      const state=await this.availableVideoFolder(projectId,id);
      if(state) {
        const {name,relativePath}=state.row;
        folders.push({id,name,relativePath});
      }
    }
    return {folders};
  }
  async confirm(handoffId,input,{sessionId}={}) {if(input?.version!==undefined&&input.version!==2)throw Object.assign(error('INTAKE_INVALID_INPUT','收纳请求版本无效',400),{accepted:false,requestId:input?.requestId});if(input?.version===2)return this.serial(()=>this.confirmUnified(handoffId,input,sessionId));return this.serial(async()=>{
    this.assertOpen();
    if(!uuid(input.requestId)||!uuid(input.projectId)||!['copy','move'].includes(input.mode)||!Array.isArray(input.fileIds)||!input.fileIds.length)
      throw error('INTAKE_INVALID_INPUT','请选择视频、项目、目标文件夹与收纳方式',400);
    if(input.mode==='move'&&!this.canTrash)throw error('TRASH_UNAVAILABLE','废纸篓组件不可用；请使用保留原文件的复制方式');
    const h=await this.receipts.read('handoffs',handoffId), ids=[...new Set(input.fileIds)];
    if(ids.length!==input.fileIds.length||ids.some(id=>!h.files.some(f=>f.id===id)))throw error('INTAKE_INVALID_INPUT','所选文件不属于这次访达选择',400);
    if(h.files.some(f=>ids.includes(f.id)&&(f.mediaKind||'video')!=='video'))throw error('INTAKE_INVALID_INPUT','旧版入口只处理视频，请升级入口后确认其他素材',400);
    const args=stable({handoffId,projectId:input.projectId,folderId:input.folderId||'root',mode:input.mode,fileIds:ids});
    const existing=[...this.batches.values()].find(b=>b.id===input.requestId||b.handoffId===handoffId);
    if(existing){if(existing.id!==input.requestId||existing.args!==args)throw error('INTAKE_ALREADY_ACCEPTED','这次选择已接收，请查看原文件任务');return this.dto(existing);}
    if(h.preparation==='checking')throw error('INTAKE_SELECTION_CHECKING','正在后台核验原文件，完成后即可确认收纳',422);
    if(h.preparation==='failed')throw error('INTAKE_SELECTION_FAILED',h.preparationError,422);
    if(h.preparation==='ready'&&h.files.some(f=>!/^[a-f0-9]{64}$/.test(f.selectionSha256||'')))throw error('INTAKE_SELECTION_FAILED','本次选择的内容证明不完整，请从访达重新选择',422);
    const project=this.catalog.project(input.projectId,true);
    const target=await this.prepareVideoFolder(project.id,input.folderId==='all'?'root':input.folderId||'root');
    const folder=target.row;
    const b={id:input.requestId,handoffId,args,libraryId:this.libraryId,projectId:project.id,projectName:project.name,folderId:input.folderId||'root',
      folderName:folder?.relativePath||'项目根目录',target,mode:input.mode,createdAt:Date.now(),updatedAt:Date.now(),status:'queued',
      items:h.files.filter(f=>ids.includes(f.id)).map(f=>({...f,status:'queued',requestId:randomUUID(),attempts:[],copiedBytes:0}))};
    await this.receipts.write('batches',b.id,b,{exclusive:true});this.batches.set(b.id,b);await this.rememberTargets([{kind:'video',scope:'project',projectId:b.projectId,folderId:b.folderId}],{mode:b.mode});this.kick();return this.dto(b);
  });}
  async rememberTargets(targets,options){try{await this.preferences?.remember(targets,options);}catch{this.preferenceWarning='目标偏好未能保存，下次请重新选择；任务已接收';}}
  context(b,i){
    if(b.version!==2)return {catalog:this.catalog,projectId:b.projectId,target:b.target,folderId:b.folderId};
    const d=i.destination;
    return {catalog:d.scope==='project'&&d.kind==='video'?this.catalog:this.generic.bind(d,i.target),projectId:d.projectId||'',target:i.target,folderId:i.resolvedFolder?.id??d.folderId??'root'};
  }
  async confirmUnified(handoffId,input,sessionId){
    let acceptanceStarted=false;const resolvedFolders=[];try{
    this.assertOpen();
    if(!this.generic||!input||(input.standardNames!==undefined&&typeof input.standardNames!=='boolean')||!uuid(input.requestId)||!['copy','move'].includes(input.mode)||!Array.isArray(input.fileIds)||!input.fileIds.length||!Array.isArray(input.targets)||input.targets.length!==input.fileIds.length||input.targets.some(t=>!t||typeof t!=='object'))
      throw error('INTAKE_INVALID_INPUT','请逐项确认素材类型与收纳目标',400);
    if(input.mode==='move'&&!this.canTrash)throw error('TRASH_UNAVAILABLE','废纸篓组件不可用，请使用复制方式');
    const h=await this.receipts.read('handoffs',handoffId),ids=[...new Set(input.fileIds)];
    if(ids.length!==input.fileIds.length||new Set(input.targets.map(t=>t.fileId)).size!==ids.length||ids.some(id=>!h.files.some(f=>f.id===id)||!input.targets.some(t=>t.fileId===id)))throw error('INTAKE_INVALID_INPUT','文件清单与目标不匹配',400);
    const singleVideo=ids.length===1&&(h.files.find(f=>f.id===ids[0]).mediaKind||'video')==='video';
    const {revealWhenDone}=input;
    if((revealWhenDone!==undefined&&typeof revealWhenDone!=='boolean')||(revealWhenDone&&!singleVideo))
      throw error('INTAKE_INVALID_INPUT','只有单个视频可以选择收纳完成后在访达中显示',400);
    const args=stable({version:2,handoffId,mode:input.mode,fileIds:ids,targets:input.targets,standardNames:input.standardNames,
      ...(revealWhenDone?{revealWhenDone:true}:{})});
    if(this.foreignIds.has(input.requestId))throw error('LOCAL_INSTANCE_CHANGED','这批文件任务属于另一素材库，原回执保留');
    const existing=[...this.batches.values()].find(b=>b.id===input.requestId||b.handoffId===handoffId);
    if(existing){if(existing.id!==input.requestId||existing.args!==args)throw error('INTAKE_ALREADY_ACCEPTED','这次选择已接收，请查看原文件任务');return this.dto(existing);}
    try {
      await this.receipts.read('batches',input.requestId);
      acceptanceStarted=true;
      throw error('INTAKE_RESULT_UNKNOWN','原批次回执已存在，请核对原请求后继续');
    }catch(e){
      if(e.code!=='ENOENT'){acceptanceStarted=true;throw e;}
    }
    if(h.preparation!=='ready'||h.files.some(f=>!/^[a-f0-9]{64}$/.test(f.selectionSha256||'')))throw error('INTAKE_SELECTION_CHECKING','原文件内容核验尚未完成，请稍候或重新选择',422);
    const items=[],plans=[],sharedImages=new Map(),planner=this.namePlanner();
    // The confirmation order owns both sequence allocation and the first
    // successful image which supplies a missing representative.
    const targets=new Map(input.targets.map(t=>[t.fileId,t])),files=new Map(h.files.map(f=>[f.id,f]));
    for(const id of ids)checkChoice(files.get(id),targets.get(id));
    const children=new Map(),preflight=new Map(),created=new Map(),confirmedParents=new Map();
    if([...targets.values()].some(t=>t.destination.newFolder)){
      for(const id of ids){
        const {destination,nameMode}=targets.get(id),f=files.get(id);
        const target=await this.planningTarget(destination,children,{write:true});
        // Verify every source, destination and name before the first folder write.
        const ctx={destination,nameMode,...target,child:destination.newFolder?target:undefined};
        preflight.set(id,ctx);
        if(!wantsStandard(destination,nameMode))planner.reserve(ctx.directory,destination.fileName??f.name);
        await revalidateSelection(f);
      }
      for(const [id,ctx] of preflight)await planner.plan(files.get(id),ctx);
    }
    for(const {child} of preflight.values())if(child&&!created.has(child)){
      const parentKey=stable([child.project.id,child.parentId]);
      const parent=confirmedParents.get(parentKey)??child.parent;
      const result=await this.resolveNewIntakeFolder({...child,parent},input.requestId);
      created.set(child,result);resolvedFolders.push(result.folder);
      confirmedParents.set(parentKey,result.parent);
    }
    const finalPlanner=preflight.size?this.namePlanner():planner;
    for(const id of ids){
      const f=files.get(id),{destination,nameMode}=structuredClone(targets.get(id));
      let target,label,ctx,resolvedFolder;
      if(destination.scope==='project'&&destination.kind==='video'){
        const project=this.catalog.project(destination.projectId,true);
        const child=created.get(preflight.get(id)?.child);
        resolvedFolder=child?.folder;
        const folderId=resolvedFolder?.id??destination.folderId??'root';
        target=await this.prepareVideoFolder(project.id,folderId);
        if(child&&!sameDirectoryState(child.state,target))throw videoFolderChanged();
        const folder=target.row;
        label=project.name+' / '+(folder?.relativePath||'项目根目录');
        ctx={project,series:this.projectSeries(project.id),folder,verify:()=>this.catalog.current(project.id,target)};
      }else{
        target=await this.generic.prepare(destination,{sharedImages,requestGroupId:input.requestId});
        label=target.label||({photo:'摄影照片',video:'视频素材',music:'音乐',sfx:'音效'}[destination.kind]+' / '+(destination.directory||'待确认'));
        ctx={assetName:target.assetName,verify:()=>this.generic.current(target)};
      }
      const item={...f,destination,...(resolvedFolder?{resolvedFolder}:{}),nameMode,target,destinationLabel:label,status:'queued',requestId:randomUUID(),attempts:[],copiedBytes:0};
      items.push(item);
      plans.push({destination,nameMode,directory:target.target,...ctx});
      if(!wantsStandard(destination,nameMode))finalPlanner.reserve(target.target,destination.fileName??f.name);
    }
    for(const [i,item] of items.entries())item.plannedFileName=(await finalPlanner.plan(item,plans[i])).proposedFileName;
    const labels=[...new Set(items.map(i=>i.destinationLabel))],projectIds=[...new Set(items.map(i=>i.destination.projectId||''))];
    const b={version:2,id:input.requestId,handoffId,args,libraryId:this.libraryId,projectId:projectIds.length===1?projectIds[0]:'',projectName:labels.length===1?labels[0]:'多种素材收纳',folderId:'',folderName:labels.length>1?labels.length+' 个固定目标':'',mode:input.mode,createdAt:Date.now(),updatedAt:Date.now(),status:'queued',items};
    acceptanceStarted=true;
    await this.receipts.write('batches',b.id,b,{exclusive:true});this.batches.set(b.id,b);
    if(singleVideo&&sessionId)this.receiptSessions.set(b.id,sessionId);
    if(revealWhenDone)this.liveReveal.add(b.id);
    await this.rememberTargets(items.map(i=>i.resolvedFolder?{...i.destination,folderId:i.resolvedFolder.id}:i.destination),{
      mode:input.mode,standardNames:input.standardNames,revealWhenDone:singleVideo?revealWhenDone:undefined,
    });
    this.kick();return this.dto(b);
    }catch(e){
      if(!acceptanceStarted)Object.assign(e,{accepted:false,requestId:input?.requestId});
      if(resolvedFolders.length)e.resolvedFolders=resolvedFolders;
      throw e;
    }
  }
  desktopError(cause) {
    if(cause.effectUnknown)return error('INTAKE_DESKTOP_UNKNOWN','未收到访达回执，请查看桌面后再操作',502);
    if(desktopUnavailable.has(cause.code))return error('INTAKE_DESKTOP_UNAVAILABLE','当前本机桌面不可用',503);
    if(cause.code==='TARGET_CHANGED'||cause.code==='FOLDER_UNAVAILABLE')return videoFolderChanged();
    return error('INTAKE_DESKTOP_FAILED','未能在访达中显示，请核对目标后重试',409);
  }
  assertDesktop() {
    if(!this.desktop||process.env.MEDIA_DISABLE_DESKTOP_NATIVE==='1'||process.env.MEDIA_READONLY_FILES==='1')
      throw error('DESKTOP_PLATFORM_UNAVAILABLE','当前本机桌面不可用',503);
  }
  async verifyDestination(b,i) {
    const {catalog,projectId,target,folderId}=this.context(b,i);
    this.assertLibrary(b);
    try{
      if(catalog===this.catalog){
        const state=await this.resolveVideoFolder(projectId,folderId);
        if(!state.exists||state.target!==target.target||!sameFolder(state.targetIdentity,target.targetIdentity))
          throw videoFolderChanged();
      }
      await catalog.current(projectId,target,{write:false});
    }catch(e){
      if(unavailableVideoFolder.has(e.code)||e.status===404)throw videoFolderChanged();
      throw e;
    }
  }
  async openFolder(id,input,{sessionId}={}) {
    this.assertOpen();
    if(input!==undefined&&input!==null&&(typeof input!=='object'||Array.isArray(input)||Object.keys(input).length))
      throw error('INTAKE_INVALID_INPUT','请使用本次收纳回执打开固定的目标文件夹',400);
    const b=this.batch(id);this.assertLibrary(b);const [i]=b.items;
    if(b.version!==2||b.items.length!==1||i.destination.kind!=='video'||!sessionId||this.receiptSessions.get(id)!==sessionId)
      throw error('INTAKE_INVALID_INPUT','仅可从本次单个视频的收纳回执打开目标文件夹',400);
    if(this.folderDispatches.has(id))return this.folderDispatches.get(id);
    const work=(async()=>{
      try{
        await this.verifyDestination(b,i);
        this.assertDesktop();
        const {target}=this.context(b,i);
        await this.desktop.openFolder(target.target,{identity:target.targetIdentity,beforeDispatch:async()=>{
          this.assertOpen();await this.verifyDestination(b,i);
        }});
        return {status:'dispatched'};
      }catch(e){throw this.desktopError(e);}
    })();
    this.folderDispatches.set(id,work);
    try{return await work;}finally{this.folderDispatches.delete(id);}
  }
  async verifiedRevealSource(b,i) {
    await this.verifyDestination(b,i);
    const {catalog,projectId,target}=this.context(b,i);
    const receipt=catalog.receipt(projectId,i.requestId);
    if(receipt.status!=='ready'||(receipt.videoId??receipt.assetId)!==(i.videoId??i.assetId))throw videoFolderChanged();
    const source=await catalog.verifiedSource(projectId,i.videoId??i.assetId);
    if(path.dirname(source.path)!==target.target||path.basename(source.path)!==i.resultFileName||source.path===i.path)
      throw videoFolderChanged();
    return source;
  }
  async revealCompleted(b,i) {
    if(!this.liveReveal.has(b.id)||i.status!=='ready')return;
    this.liveReveal.delete(b.id);
    if((b.mode==='move'&&i.removal!=='complete')||i.revealAttemptedAt)return;
    const at=Date.now();
    // Write the attempt first. A lost native or process response must never
    // cause a second Finder selection during retry or recovery.
    i.revealAttemptedAt=at;await this.save(b,{touch:false});
    let result;
    try{
      this.assertOpen();this.assertDesktop();
      const source=await this.verifiedRevealSource(b,i);
      await this.desktop.revealFiles([source.path],{identity:{dev:source.identity.dev,ino:source.identity.ino},beforeDispatch:async()=>{
        this.assertOpen();
        const current=await this.verifiedRevealSource(b,i);
        if(current.path!==source.path||!same(current.identity,source.identity))throw videoFolderChanged();
      }});
      result={status:'dispatched',at};
    }catch(e){
      const fault=this.desktopError(e);
      result={status:e.effectUnknown?'unknown':'failed',at,error:{code:fault.code,message:fault.message}};
    }
    const snapshot=structuredClone(b);snapshot.items.find(item=>item.id===i.id).reveal=result;
    await this.save(snapshot,{touch:false});i.reveal=result;
  }
  summarize(b) {
    if(b.items.some(i=>i.status==='copying'))b.status='running';
    else if(b.items.some(i=>i.status==='queued'))b.status='queued';
    else if(b.items.some(i=>['duplicate','unknown'].includes(i.status)))b.status='waiting';
    else if(b.items.some(i=>['failed','source_retained'].includes(i.status)))b.status='partial';
    else b.status='completed';
  }
  kick() {
    if(this.closing||this.work)return;
    clearTimeout(this.timer);this.timer=null;
    this.work=Promise.resolve().then(()=>this.withActivity(async()=>{
      for(const b of this.batches.values()) {
        if(b.status==='interrupted')continue;
        for(const i of b.items) {
          if(this.closing)break;
          if(i.status!=='queued')continue;
          const processed=await this.catalog.media.track(async()=>{
            let processed;
            try {processed=await this.process(b,i);} catch(e) {
              if(e.code==='IMPORT_BUSY') {i.status='queued';i.error='等待当前视频导入结束';}
              else if(i.status!=='unknown'&&i.status!=='source_retained') {i.status='failed';i.error=e.message;i.code=e.code;}
            }
            this.summarize(b);await this.save(b);
            return processed;
          });
          if(processed&&i.status==='ready'&&this.liveReveal.has(b.id))await this.serial(()=>this.revealCompleted(b,i));
        }
      }
    })).catch(e=>{this.lastError=e;}).finally(()=>{
      this.work=null;
      if(!this.closing&&[...this.batches.values()].some(b=>b.status!=='interrupted'&&b.items.some(i=>i.status==='queued')))
        this.timer=setTimeout(()=>this.kick(),1000);
    });
  }
  async managed(i,kind) {
    const asset=this.catalog.db.prepare('SELECT * FROM assets WHERE path=? AND trashed=0').get(i.path);
    if(!asset||(kind&&asset.kind!==kind)||String(asset.dev)!==i.identity.dev||String(asset.ino)!==i.identity.ino||asset.size!==i.bytes||asset.mtime!==i.identity.mtimeMs)return false;
    for(const r of this.catalog.db.prepare('SELECT * FROM project_video_records').all()) {
      const d=JSON.parse(r.data_json);
      if(d.removedAt||!d.managed||d.mediaAssetId!==asset.id)continue;
      const source=await this.catalog.verifiedSource(r.project_id,r.id);
      await this.catalog.hash(source.path,source.identity);
      i.managedProjectId=r.project_id;i.managedProjectName=this.catalog.project(r.project_id).name;i.videoId=r.id;break;
    }
    i.assetId=asset.id;i.status='managed';i.error='已在素材库中；可查看或使用原移动入口，标签与关联保留';return true;
  }
  applyReceipt(i,r) {
    i.error=r.error||undefined;i.adoptionStamp=r.adoptionStamp;i.candidates=r.candidates;
    if(r.status==='ready'){i.status='ready';i.resultFileName=r.fileName;i.videoId=r.videoId;i.assetId=r.assetId;i.creativeAssetId=r.creativeAssetId;i.lookId=r.lookId;i.bindingId=r.bindingId;i.copiedBytes=i.bytes;}
    else if(r.status==='duplicate')i.status='duplicate';
    else if(r.status==='failed'){i.status='failed';i.error=r.error;}
    else i.status='unknown';
  }
  async process(b,i) {
    const {catalog,projectId,target,folderId}=this.context(b,i);
    this.assertOpen();this.assertLibrary(b);await catalog.current(projectId,target);
    const currentIdentity=await revalidateSelection(i);
    if(!same(currentIdentity,i.identity)){i.selectionIdentity??={...i.identity};i.identity=currentIdentity;await this.save(b);}
    if((b.version!==2||i.destination.scope==='library')&&await this.managed(i,i.destination?.kind))return;
    const args={requestId:i.requestId,fileName:i.plannedFileName??i.destination?.fileName??i.name,bytes:i.bytes,prompt:{mode:'none'},folderId};
    const started=await catalog.startIntake(projectId,args,target);
    if(started.status!=='waiting') {this.applyReceipt(i,started);return;}
    i.status='copying';b.status='running';i.error=undefined;i.copiedBytes=0;await this.save(b);
    let handle;
    try {handle=await fs.open(i.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
    catch(e){await catalog.resolve(projectId,i.requestId,{choice:'cancel'});throw e;}
    const self=this;
    const hash=createHash('sha256');let lastSaved=0;
    async function* content() {
      if(!same(stamp(await handle.stat()),i.identity))throw error('INTAKE_SOURCE_CHANGED','原文件已变化');
      for await(const chunk of handle.createReadStream({autoClose:false})) {
        self.assertOpen();i.copiedBytes+=chunk.length;hash.update(chunk);
        if(Date.now()-lastSaved>500){await self.save(b);lastSaved=Date.now();}
        yield chunk;
      }
      if(!same(stamp(await handle.stat()),i.identity))throw error('INTAKE_SOURCE_CHANGED','复制期间原文件发生变化，未移除原文件');
      await unchanged(i.path,i.identity);
      if(i.selectionSha256&&hash.copy().digest('hex')!==i.selectionSha256)throw error('INTAKE_SOURCE_CHANGED','原文件内容与选择时不同，未发布或移除原文件');
    }
    try {
      const r=await catalog.upload(projectId,i.requestId,content());i.sha256=hash.digest('hex');this.applyReceipt(i,r);
      await this.save(b);
      if(i.status==='ready')await this.completeReady(b,i);
      else if(i.status==='duplicate'&&b.defaultChoice&&b.items.indexOf(i)>(b.defaultChoiceAfter??-1)&&stable(i.destination)===b.defaultChoiceDestination) {
        const candidate=i.candidates?.[0];
        const choice=b.defaultChoice;
        if(choice==='import'||choice==='reuse'&&i.candidates?.length===1) {
          const result=await catalog.resolve(projectId,i.requestId,{choice,candidateId:candidate?.id});
          this.applyReceipt(i,result);if(i.status==='ready')await this.completeReady(b,i);
        }
      }
    } catch(e) {
      const r=catalog.receipt(projectId,i.requestId);
      if(r.published||r.status==='unknown'){i.status='unknown';i.error='文件可能已复制，需核对原回执；未重发或移除原文件';}
      throw e;
    } finally {await handle.close();}
    return true;
  }
  async completeReady(b,i) {
    const {catalog,projectId,target,folderId}=this.context(b,i);
    // Only this instance's durable ready intake stages qualify for removal.
    // A retained stage is a visible housekeeping warning, never a failed import.
    this.finalizing.add(i.id);
    try{return await this.withActivity(()=>catalog.media.track(async()=>{
      let warning;
      try{await catalog.cleanupIntakeStage(projectId,i.requestId);}
      catch(e){warning='素材已收纳；临时副本保留待核对：'+e.message;i.error=warning;}
      await this.finishMove(b,i);
      if(warning&&i.status==='ready')i.error=warning;
    }));}finally{this.finalizing.delete(i.id);}
  }
  async boundTrash(file,expected) {
    const child=spawn(this.catalog.lib.trashBin,[file,JSON.stringify(expected)],{stdio:['ignore','pipe','pipe'],shell:false});
    let out='',stderr='',spawnError;
    this.catalog.media.children.add(child);
    const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
    this.catalog.media.exits.set(child,closed);child.once('error',e=>{spawnError=e;});
    child.stdout.on('data',b=>{if(out.length<16384)out+=b;});child.stderr.on('data',b=>{if(stderr.length<16384)stderr+=b;});
    try{const end=await closed;
      if(spawnError||end.code!==0||end.signal)throw error('INTAKE_TRASH_UNSETTLED',stderr.trim()||'废纸篓组件未正常完成，原结果保留待核对');
      const destination=JSON.parse(out);if(typeof destination!=='string'||!destination.startsWith('/'))throw error('INTAKE_TRASH_UNKNOWN','废纸篓结果待核对');return destination;
    }finally{this.catalog.media.children.delete(child);this.catalog.media.exits.delete(child);}
  }
  async finishMove(b,i) {
    const {catalog,projectId}=this.context(b,i);
    if(b.mode!=='move'||i.status!=='ready')return;
    let removalStarted=false;
    // A durable successful registration is required before even considering the
    // source. Reuse/managed files and files indexed during copying are retained.
    try {
      const raw=catalog.receipt(projectId,i.requestId);
      if(raw.reused){i.status='source_retained';i.error='已收纳，原文件未移除：复用了已有素材';return;}
      const source=await catalog.verifiedSource(projectId,i.videoId||i.assetId);
      if(raw.status!=='ready'||source.path===i.path) {i.status='source_retained';i.error='已收纳，原文件未移除：采用的是同一已管理文件';return;}
      await unchanged(i.path,i.identity);
      if(catalog.db.prepare('SELECT id FROM assets WHERE path=? AND trashed=0').get(i.path))throw error('SOURCE_MANAGED','原文件已被素材库管理，请使用素材库移动入口');
      const d=await catalog.hash(source.path,source.identity);
      if(!i.sha256||d.hash!==i.sha256)throw error('INTAKE_COPY_UNVERIFIED','目标不是已完整校验的原文件副本');
      await unchanged(i.path,i.identity);this.assertOpen();
      i.removal='planned';await this.save(b);await catalog.media.verify(source);
      await unchanged(i.path,i.identity);
      if(!i.parentIdentity)throw error('INTAKE_SOURCE_UNBOUND','原文件夹身份未固定，原件保留');
      this.assertOpen();
      if(catalog.db.prepare('SELECT id FROM assets WHERE path=? AND trashed=0').get(i.path))throw error('SOURCE_MANAGED','原文件已被素材库管理，请使用素材库移动入口');
      // The plan write and file checks yield to project edits. Check the exact
      // binding again in the same turn that dispatches the native move.
      catalog.assertIntakeBinding?.(projectId,i.requestId);
      removalStarted=true;
      const target=await this.trash(i.path,{identity:i.identity,parent:i.parentIdentity,sha256:i.sha256});i.trashPath=target;await this.save(b);
      const st=await fs.lstat(target);
      if(st.isSymbolicLink()||String(st.dev)!==i.identity.dev||String(st.ino)!==i.identity.ino||st.size!==i.bytes||st.mtimeMs!==i.identity.mtimeMs)
        throw error('INTAKE_TRASH_UNKNOWN','废纸篓结果待核对');
      const exists=await fs.lstat(i.path).catch(e=>e.code==='ENOENT'?null:Promise.reject(e));
      if(exists)throw error('INTAKE_TRASH_UNKNOWN','原位置出现文件，未再移除');
      i.removal='complete';i.error=undefined;
    } catch(e) {
      let sourceStillThere=false;
      try{await unchanged(i.path,i.identity);sourceStillThere=true;}catch{}
      if(!removalStarted&&sourceStillThere&&i.removal==='planned')delete i.removal;
      i.status=i.removal==='planned'&&!sourceStillThere?'unknown':'source_retained';i.code=e.code;
      i.error='已收纳，原文件未移除或结果待核对：'+e.message;
    }
  }
  async resolve(id,itemId,input) {return this.serial(async()=>{
    this.assertOpen();const b=this.batch(id);this.assertLibrary(b);const i=b.items.find(i=>i.id===itemId);
    if(!i||i.status!=='duplicate')throw error('INTAKE_ITEM_NOT_WAITING','原文件任务状态已变化，请重新读取');
    if(!['import','rename','reuse','overwrite','cancel'].includes(input.choice))throw error('INVALID_CHOICE','请选择同名处理方式',400);
    const {catalog,projectId,target}=this.context(b,i);
    if(input.choice!=='cancel')await catalog.current(projectId,target);
    try {
      const r=await this.withActivity(()=>catalog.media.track(()=>catalog.resolve(projectId,i.requestId,input)));
      this.applyReceipt(i,r);
      if(input.choice==='cancel')i.status='cancelled';
      if(input.applyRemaining&&['import','rename','reuse'].includes(input.choice)) {
        b.defaultChoice=input.choice==='rename'?'import':input.choice;b.defaultChoiceDestination=stable(i.destination);b.defaultChoiceAfter=b.items.indexOf(i);
        // Small files may all reach the duplicate state before the user chooses.
        // Apply the explicit decision to later waiting items as well as new ones.
        for(const next of b.items.slice(b.defaultChoiceAfter+1))if(next.status==='duplicate'&&stable(next.destination)===stable(i.destination)) {
          const {catalog,projectId}=this.context(b,next);
          if(b.defaultChoice==='reuse'&&next.candidates?.length!==1){next.error='存在多个同名候选，请逐项核对后复用';continue;}
          try {
            const candidate=next.candidates?.[0],result=await this.withActivity(()=>catalog.media.track(()=>
              catalog.resolve(projectId,next.requestId,{choice:b.defaultChoice,candidateId:candidate?.id})));
            this.applyReceipt(next,result);if(next.status==='ready')await this.completeReady(b,next);
          }catch(e){this.applyReceipt(next,catalog.receiptDTO(catalog.receipt(projectId,next.requestId)));next.error=e.message;}
          await this.save(b);
        }
      }
      if(i.status==='ready')await this.completeReady(b,i);
    } catch(e) {this.applyReceipt(i,catalog.receiptDTO(catalog.receipt(projectId,i.requestId)));throw e;}
    finally {this.summarize(b);await this.save(b);this.kick();}
    if(input.choice!=='cancel')await this.revealCompleted(b,i);
    return this.dto(b);
  });}
  async reconcile(id) {return this.serial(async()=>{
    const b=this.batch(id);this.assertLibrary(b);
    for(const i of b.items) {
      if(!['unknown','duplicate'].includes(i.status))continue;
      const {catalog,projectId}=this.context(b,i);
      let r;try{r=catalog.receipt(projectId,i.requestId);}catch(e){if(e.code!=='IMPORT_NOT_FOUND')continue;}
      if(!r){i.code='INTAKE_NOT_STARTED';i.error='原导入未被接收，可明确重试；原文件保留';i.status='failed';continue;}
      if(r.status==='ready') {
        this.applyReceipt(i,catalog.receiptDTO(r));
        if(b.mode==='move'&&i.removal!=='complete'){i.status='source_retained';i.error='已核对原收纳成功；中断后的原文件保留，不自动移除';}
      } else if(r.status==='duplicate')this.applyReceipt(i,catalog.receiptDTO(r));
      else if(r.status==='failed'&&!r.published){this.applyReceipt(i,catalog.receiptDTO(r));}
      else if(r.status==='waiting'&&r.instance!==catalog.instance&&!catalog.running.has(i.requestId)){
        i.status='failed';i.code='INTAKE_NOT_STARTED';i.error='原回执确认尚未接收文件，可明确重试；原文件保留';
      }
      else {i.status='unknown';i.error='原导入结果尚未核清，未重发或移除原文件';}
    }
    this.summarize(b);await this.save(b);return this.dto(b);
  });}
  async retry(id,itemId) {return this.serial(async()=>{
    this.assertOpen();const b=this.batch(id);this.assertLibrary(b);const i=b.items.find(i=>i.id===itemId);
    if(!i||i.status!=='failed')throw error('INTAKE_RETRY_REFUSED','只有明确失败的未完成文件可以重试');
    const {catalog,projectId,target,folderId}=this.context(b,i);let r;try{r=catalog.receipt(projectId,i.requestId);}catch{}
    if(r?.status==='waiting'&&r.instance!==catalog.instance&&!r.published&&!catalog.running.has(i.requestId))
      await catalog.resolve(projectId,i.requestId,{choice:'cancel'});
    else if(r&&(r.status!=='failed'||r.published))throw error('INTAKE_RESULT_UNKNOWN','原导入可能已接收，请先核对原回执');
    await unchanged(i.path,i.identity);await catalog.current(projectId,target);
    i.attempts.push({requestId:i.requestId,status:i.status,error:i.error});i.requestId=randomUUID();i.status='queued';i.error=undefined;
    this.summarize(b);await this.save(b);this.kick();return this.dto(b);
  });}
  beginClose(){this.closing=true;clearTimeout(this.timer);}
  async close(){this.beginClose();let timer;
    const settling=(async()=>{await this.operation;if(this.work)await this.work;
      for(const b of this.batches.values())if(b.items.some(i=>i.status==='queued')){b.status='interrupted';await this.save(b);}
      await this.writes;await this.preferences?.close();if(this.lastError)throw this.lastError;
    })();
    try{await Promise.race([settling,new Promise((_,reject)=>{timer=setTimeout(()=>reject(error('FILE_INTAKE_WORK_UNSETTLED','文件任务尚未正常结清，未强制结束')),10000);})]);}
    finally{clearTimeout(timer);}
  }
}
