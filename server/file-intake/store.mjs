import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {Receipts,uuid,stamp,same,unchanged,revalidateSelection,error} from './files.mjs';

import {defaultRoutingPreferences} from './preferences.mjs';
import {IntakeNames,checkChoice,wantsStandard} from './names.mjs';

const stable = value => JSON.stringify(value);
const pending = new Set(['queued','copying','duplicate','unknown']);
const terminal = new Set(['ready','managed','failed','cancelled','source_retained']);
const unavailableVideoFolder = new Set(['ENOENT','ENOTDIR','FOLDER_NOT_FOUND','TARGET_CHANGED']);
const videoFolderChanged = () => error('TARGET_CHANGED','所选项目视频文件夹已移动、删除或变化，请重新选择');
const publicItem = i => ({id:i.id,name:i.name,bytes:i.bytes,copiedBytes:i.copiedBytes||0,status:i.status,
  error:i.error,code:i.code,videoId:i.videoId,assetId:i.assetId,managedProjectId:i.managedProjectId,
  managedProjectName:i.managedProjectName,destination:i.destination,nameMode:i.nameMode,plannedFileName:i.plannedFileName,resultFileName:i.resultFileName,destinationLabel:i.destinationLabel,creativeAssetId:i.creativeAssetId,lookId:i.lookId,bindingId:i.bindingId,mediaKind:i.mediaKind,adoptionStamp:i.adoptionStamp,candidates:i.candidates});

export class FileIntake {
  constructor({dataDir,catalog,projects,withActivity=fn=>fn(),trash,libraryId=dataDir,generic,preferences}) {
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
      projects.push({id,name,videoFolders,assets:assets.all(id).map(({default_look_id,...a})=>({
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
  async previewNameTarget(destination) {
    if(destination.scope!=='project')return {};
    if(destination.kind==='video'){
      const project=this.catalog.project(destination.projectId);
      const id=destination.folderId??'root', state=await this.resolveVideoFolder(project.id,id);
      return {project,folder:state.row,directory:state.target,verify:async()=>{
        const again=await this.resolveVideoFolder(project.id,id);
        if(again.target!==state.target||again.exists!==state.exists||stable(again.targetIdentity)!==stable(state.targetIdentity))
          throw error('TARGET_CHANGED','核对名称期间目录已变化');
      }};
    }
    const state=await this.generic.previewImageTarget(destination);
    return {directory:state.target,assetName:state.assetName,verify:state.verify};
  }
  async namePreview(id,input) {
    this.assertOpen();
    const h=await this.receipts.read('handoffs',id),files=new Map(h.files.map(f=>[f.id,f]));
    if(!Array.isArray(input?.targets)||input.targets.length>h.files.length||input.targets.some(t=>!t||!files.has(t.fileId))||
        new Set(input.targets.map(t=>t.fileId)).size!==input.targets.length)
      throw error('INTAKE_INVALID_INPUT','文件清单与目标不匹配',400);
    const planner=this.namePlanner(),rows=[];
    for(const target of input.targets){
      const f=files.get(target.fileId),result={fileId:f.id,proposedFileName:null,proposedNumber:null};
      try {
        checkChoice(f,target);
        const {destination,nameMode}=target,ctx={destination,nameMode,...await this.previewNameTarget(destination)};
        if(!wantsStandard(ctx.destination,ctx.nameMode))planner.reserve(ctx.directory,ctx.destination.fileName??f.name);
        rows.push({f,ctx,result});
      }catch(e){rows.push({result:{...result,error:this.namePreviewError(e)}});}
    }
    for(const row of rows)if(row.ctx)try{Object.assign(row.result,await planner.plan(row.f,row.ctx));}
    catch(e){row.result.error=this.namePreviewError(e);}
    return {items:rows.map(row=>row.result)};
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
  async confirm(handoffId,input) {if(input?.version!==undefined&&input.version!==2)throw Object.assign(error('INTAKE_INVALID_INPUT','收纳请求版本无效',400),{accepted:false,requestId:input?.requestId});if(input?.version===2)return this.serial(()=>this.confirmUnified(handoffId,input));return this.serial(async()=>{
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
    return {catalog:d.scope==='project'&&d.kind==='video'?this.catalog:this.generic.bind(d,i.target),projectId:d.projectId||'',target:i.target,folderId:d.folderId||'root'};
  }
  async confirmUnified(handoffId,input){
    let acceptanceStarted=false;try{
    this.assertOpen();
    if(!this.generic||!input||(input.standardNames!==undefined&&typeof input.standardNames!=='boolean')||!uuid(input.requestId)||!['copy','move'].includes(input.mode)||!Array.isArray(input.fileIds)||!input.fileIds.length||!Array.isArray(input.targets)||input.targets.length!==input.fileIds.length||input.targets.some(t=>!t||typeof t!=='object'))
      throw error('INTAKE_INVALID_INPUT','请逐项确认素材类型与收纳目标',400);
    if(input.mode==='move'&&!this.canTrash)throw error('TRASH_UNAVAILABLE','废纸篓组件不可用，请使用复制方式');
    const h=await this.receipts.read('handoffs',handoffId),ids=[...new Set(input.fileIds)];
    if(ids.length!==input.fileIds.length||new Set(input.targets.map(t=>t.fileId)).size!==ids.length||ids.some(id=>!h.files.some(f=>f.id===id)||!input.targets.some(t=>t.fileId===id)))throw error('INTAKE_INVALID_INPUT','文件清单与目标不匹配',400);
    const args=stable({version:2,handoffId,mode:input.mode,fileIds:ids,targets:input.targets,standardNames:input.standardNames});
    const existing=[...this.batches.values()].find(b=>b.id===input.requestId||b.handoffId===handoffId);
    if(existing){if(existing.id!==input.requestId||existing.args!==args)throw error('INTAKE_ALREADY_ACCEPTED','这次选择已接收，请查看原文件任务');return this.dto(existing);}
    if(h.preparation!=='ready'||h.files.some(f=>!/^[a-f0-9]{64}$/.test(f.selectionSha256||'')))throw error('INTAKE_SELECTION_CHECKING','原文件内容核验尚未完成，请稍候或重新选择',422);
    const items=[],plans=[],sharedImages=new Map(),planner=this.namePlanner();
    // The confirmation order owns both sequence allocation and the first
    // successful image which supplies a missing representative.
    const targets=new Map(input.targets.map(t=>[t.fileId,t])),files=new Map(h.files.map(f=>[f.id,f]));
    for(const id of ids)checkChoice(files.get(id),targets.get(id));
    for(const id of ids){
      const f=files.get(id),{destination,nameMode}=structuredClone(targets.get(id));
      let target,label,ctx;
      if(destination.scope==='project'&&destination.kind==='video'){
        const project=this.catalog.project(destination.projectId,true),folderId=destination.folderId??'root';
        target=await this.prepareVideoFolder(project.id,folderId);
        const folder=target.row;
        label=project.name+' / '+(folder?.relativePath||'项目根目录');
        ctx={project,folder,verify:()=>this.catalog.current(project.id,target)};
      }else{
        target=await this.generic.prepare(destination,{sharedImages,requestGroupId:input.requestId});
        label=target.label||({photo:'摄影照片',video:'视频素材',music:'音乐',sfx:'音效'}[destination.kind]+' / '+(destination.directory||'待确认'));
        ctx={assetName:target.assetName,verify:()=>this.generic.current(target)};
      }
      const item={...f,destination,nameMode,target,destinationLabel:label,status:'queued',requestId:randomUUID(),attempts:[],copiedBytes:0};
      items.push(item);
      plans.push({destination,nameMode,directory:target.target,...ctx});
      if(!wantsStandard(destination,nameMode))planner.reserve(target.target,destination.fileName??f.name);
    }
    for(const [i,item] of items.entries())item.plannedFileName=(await planner.plan(item,plans[i])).proposedFileName;
    const labels=[...new Set(items.map(i=>i.destinationLabel))],projectIds=[...new Set(items.map(i=>i.destination.projectId||''))];
    const b={version:2,id:input.requestId,handoffId,args,libraryId:this.libraryId,projectId:projectIds.length===1?projectIds[0]:'',projectName:labels.length===1?labels[0]:'多种素材收纳',folderId:'',folderName:labels.length>1?labels.length+' 个固定目标':'',mode:input.mode,createdAt:Date.now(),updatedAt:Date.now(),status:'queued',items};
    acceptanceStarted=true;await this.receipts.write('batches',b.id,b,{exclusive:true});this.batches.set(b.id,b);await this.rememberTargets(items.map(i=>i.destination),{mode:input.mode,standardNames:input.standardNames});this.kick();return this.dto(b);
    }catch(e){if(!acceptanceStarted)Object.assign(e,{accepted:false,requestId:input?.requestId});throw e;}
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
    this.work=Promise.resolve().then(()=>this.withActivity(()=>this.catalog.media.track(async()=>{
      for(const b of this.batches.values()) {
        if(b.status==='interrupted')continue;
        for(const i of b.items) {
          if(this.closing)break;
          if(i.status!=='queued')continue;
          try {await this.process(b,i);} catch(e) {
            if(e.code==='IMPORT_BUSY') {i.status='queued';i.error='等待当前视频导入结束';}
            else if(i.status!=='unknown'&&i.status!=='source_retained') {i.status='failed';i.error=e.message;i.code=e.code;}
          }
          this.summarize(b);await this.save(b);
        }
      }
    }))).catch(e=>{this.lastError=e;}).finally(()=>{
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
