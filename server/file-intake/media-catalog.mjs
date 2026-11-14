import fs from 'node:fs/promises';
import fsSync, {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {canonical,digest} from '../project-assets/model.mjs';
import {projectFolderName} from '../prompt-codex/pictures.mjs';
import {within,rootIdentity,indexFileIdentity,kindForExt} from '../fs-identity.mjs';
import {directoryClass} from '../directory-classification.mjs';
import {error,uuid,stamp,same} from './files.mjs';
import {MediaReceipts,assertDirectories,directoryIdentity,sameDirectory} from './media-receipts.mjs';
import {allocatedId,imageProposal,normalizeProposal,imageAllocation,imageGuard,bindingInput} from './media-images.mjs';

const kinds=['photo','video','music','sfx'];
const rootNames={photo:'system_picture',video:'system_video',music:'system_music',sfx:'system_sfx'};
const labels={photo:'摄影照片',video:'视频素材',music:'音乐',sfx:'音效'};
const proposalKeys=['characterName','lookName','characterId','characterRevision','lookId','lookRevision','newCharacter','newLook'];
const nameKey = name => name.normalize('NFC').toLowerCase();
export function validName(value) {
  if(typeof value!=='string' || !value || value.length>240 || Buffer.byteLength(value)>240 ||
      /^[. ]|[<>:"/\\|?*\x00-\x1f\x7f]|[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value))
    throw error('INVALID_DESTINATION','副本或文件夹名称无效',400);
  return value.normalize('NFC');
}
function relativeDirectory(value='') {
  if(typeof value!=='string' || value.includes('\\') || path.isAbsolute(value)) throw error('INVALID_DESTINATION','请选择系统目录内的相对分类',400);
  if(!value) return '';
  const parts=value.split('/');
  if(parts.length>2) throw error('INVALID_DESTINATION','分类最多两层',400);
  return parts.map(validName).join('/');
}
function destination(value) {
  if(!value || typeof value!=='object' || !kinds.includes(value.kind) || !['library','project'].includes(value.scope))
    throw error('INVALID_DESTINATION','素材类型或收纳范围无效',400);
  const d={kind:value.kind,scope:value.scope};
  if(value.fileName!==undefined) d.fileName=validName(value.fileName);
  if(d.scope==='library') {
    if(value.projectId || value.assetKind!==undefined || value.assetId!==undefined || value.assetRevision!==undefined || value.characterId || value.characterName || value.lookId || value.lookName || value.imageProposal || value.folderId && value.folderId!=='root')
      throw error('INVALID_DESTINATION','通用素材库目标不能携带项目绑定',400);
    d.directory=relativeDirectory(value.directory??'');
  } else {
    if(d.kind!=='photo') throw error('INVALID_DESTINATION','通用入口的项目目标仅支持图片；项目视频使用原入口',400);
    if(!uuid(value.projectId) || value.directory || value.folderId && value.folderId!=='root') throw error('INVALID_DESTINATION','项目图片目标无效',400);
    d.projectId=value.projectId;
    if(value.assetKind!==undefined || value.assetId!==undefined || value.assetRevision!==undefined) {
      if(!['scene','prop'].includes(value.assetKind)||!uuid(value.assetId)||!Number.isSafeInteger(value.assetRevision)||value.assetRevision<1||
          value.imageProposal!==undefined||proposalKeys.some(k=>value[k]!==undefined))
        throw error('INVALID_IMAGE_TARGET','请明确选择现有场景或道具及其版本',400);
      Object.assign(d,{assetKind:value.assetKind,assetId:value.assetId,assetRevision:value.assetRevision});
    } else {
      const p=normalizeProposal(d.projectId,value.imageProposal??{projectId:d.projectId,...Object.fromEntries(proposalKeys.map(k=>[k,value[k]]))});
      for(const key of proposalKeys) d[key]=p[key];
    }
  }
  return d;
}
const proposalOf = d => ({projectId:d.projectId,...Object.fromEntries(proposalKeys.map(k=>[k,d[k]]))});
const imageIds=(d,group)=>d.assetKind?{assetId:d.assetId,lookId:null}:imageAllocation(proposalOf(d),group);
const assetProof = a => a && canonical(Object.fromEntries(['id','root_id','path','kind','trashed','dev','ino','size','mtime','sha256','category','sub','review','confirmed'].map(k=>[k,a[k]])));
const rootProof = r => r && canonical({id:r.id,path:r.path,kind:r.kind,retired:r.retired||0});
const contentOf = a => ({id:a.id,project_id:a.project_id,kind:a.kind,name:a.name,base_info:a.base_info,performance_info:a.performance_info,details:a.details,
  default_look_id:a.default_look_id,default_image_id:a.default_image_id,archived_at:a.archived_at,
  looks:a.looks.map(l=>({id:l.id,name:l.name,tags:l.tags,description:l.description,default_image_id:l.default_image_id,archived_at:l.archived_at})),
  images:a.images.map(b=>({id:b.id,look_id:b.look_id,media_asset_id:b.media_asset_id,expected_sha256:b.expected_sha256,last_known_name:b.last_known_name,
    reference_type:b.reference_type,purpose:b.purpose,locks:b.locks,ignores:b.ignores,confirmed:b.confirmed,crop:b.crop,archived_at:b.archived_at}))});

/** directory is personal_item, not a type root. No engines or original-file
 * deletion are performed. prepare(d,{sharedImages:new Map(),requestGroupId?})
 * shares deterministic new character/look IDs across one confirmed batch.
 * libraryId identifies the actual library independently of the journal path. */
export class ManagedIntakeCatalog {
  constructor({catalog,assets,dataDir,directory,libraryId=dataDir,onRootAdded=async()=>{}}) {
    if(!catalog?.media || !assets || !path.isAbsolute(directory??'') || !path.isAbsolute(dataDir??'')) throw error('INVALID_DESTINATION','通用收纳构造参数不完整',400);
    if(typeof libraryId!=='string' || !libraryId.trim() || libraryId.length>8192 || /[\x00-\x1f\x7f]/.test(libraryId)) throw error('INVALID_LIBRARY_ID','素材库身份无效',400);
    this.catalog=catalog;this.assets=assets;this.lib=catalog.lib;this.media=catalog.media;
    this.directory=path.resolve(directory);this.dataDir=path.resolve(dataDir);this.libraryId=libraryId;this.onRootAdded=onRootAdded;
    this.instance=randomUUID();this.running=new Set();this.queue=Promise.resolve();this.completed=new Map();
  }
  get db(){return this.lib.db;}
  assertAvailable(){if(this.initializationError) throw this.initializationError;}
  serial(fn){const work=this.queue.then(()=>{this.assertAvailable();return fn();});this.queue=work.catch(()=>{});return work;}
  assertTargetLibrary(target) {
    this.assertAvailable();
    if(target?.libraryId!==this.libraryId) throw error('LOCAL_INSTANCE_CHANGED','固定收纳目标属于另一素材库，未继续或认领');
  }
  ownsReceipt(s) {return s?.library===this.dataDir && s.libraryId===this.libraryId && s.target?.libraryId===this.libraryId;}
  assertReceiptLibrary(s) {
    this.assertAvailable();
    if(!this.ownsReceipt(s)) throw error('LOCAL_INSTANCE_CHANGED','收纳回执属于另一素材库，未认领、恢复或回写');
  }
  writable() {
    this.assertAvailable();
    if(process.env.MEDIA_READONLY_FILES==='1') throw error('READONLY_FILES','素材文件只读',403);
    if(this.media.closing || this.lib.migrating) throw error('IMPORT_BUSY','素材模块正在关闭或迁移',423);
  }
  project(id,write=false) {
    this.assertAvailable();
    const p=this.assets.project(id,write);
    if(p.project_kind!=='normal' || p.archived || p.archived_at) throw error('IMAGE_TARGET_CONFLICT','目标项目不可写');
    if(write) {this.writable();this.assets.generationLocks?.assertWritable(id);this.assets.storyboards?.generationLocks?.assertWritable(id);}
    return p;
  }
  async init() {
    delete this.initializationError;this.completed.clear();
    try {
    const parent=await fs.realpath(path.dirname(this.directory));
    this.directory=path.join(parent,path.basename(this.directory));
    this.anchor={path:parent,identity:directoryIdentity(await fs.lstat(parent))};
    this.dataDir=await fs.realpath(this.dataDir);
    this.receipts=new MediaReceipts(path.join(this.dataDir,'file-intake','media-imports')).init();
    for(const s of this.receipts.list()) {
      // Path-only legacy journals have no actual-library authority. Leave them
      // and every foreign library's bytes untouched, including crash intents.
      if(!this.ownsReceipt(s)) continue;
      if(s.status==='ready') this.completed.set(s.id,s);
      else if(['uploading','publishing','committing','unknown'].includes(s.status)) {
        // Recover a committed transaction only by preallocated IDs, content and
        // revision. No unknown journal is ever retried or claimed by a name.
        let recovered=false;
        if(s.commit) {try {await this.recover(s);recovered=true;} catch {}}
        if(!recovered) {
          s.status=s.publicationAttempt||s.commit?'unknown':'failed';
          s.error='上次运行已中断；原件与回执保留，未自动重发';this.persist(s);
        }
      }
    }
    } catch(e) {
      this.completed.clear();
      this.initializationError=error('INTAKE_STORAGE_UNAVAILABLE','文件收纳回执不可用，未开始或恢复任务；原件与原回执保留，请检查本机数据目录权限',503);
      Object.defineProperty(this.initializationError,'cause',{value:e});
    }
    return this;
  }
  persist(s,options){
    this.assertReceiptLibrary(s);
    if(!options?.exclusive) this.assertReceiptLibrary(this.receipts.read(s.id));
    this.receipts.write(s,options);if(s.status==='ready') this.completed.set(s.id,structuredClone(s));
  }
  groupOwns(group,a) {
    const proof=digest(a);
    return [...this.completed.values()].some(s=>this.ownsReceipt(s) && s.target.requestGroupId===group && s.creativeAssetId===a.id && s.afterFingerprint===proof);
  }
  async imageProposal(projectId,name,lookName) {
    const p=imageProposal(this,projectId,name,lookName);
    return {destination:{kind:'photo',scope:'project',...p},message:(p.newCharacter?'新建人物':'使用已有的人物')+'「'+p.characterName+'」，'+(p.newLook?'新建造型':'使用已有造型')+'「'+p.lookName+'」'};
  }
  imageTarget(target) {
    return target.destination.assetKind?target:{...target,destination:{...target.destination,imageProposal:proposalOf(target.destination)}};
  }
  async ensureDirectory(directory,{privateOnly=false,create=true}={}) {
    assertDirectories([this.anchor]);
    const present=await fs.lstat(directory).catch(e=>e.code==='ENOENT'?null:Promise.reject(e));
    if(!present) {
      if(!create) throw error('TARGET_CHANGED','原目标文件夹已不存在');
      await fs.mkdir(directory,{mode:0o700});
    }
    const st=await fs.lstat(directory);
    if(!st.isDirectory() || st.isSymbolicLink() || await fs.realpath(directory)!==directory ||
        privateOnly && ((process.getuid && st.uid!==process.getuid()) || process.platform!=='win32' && (st.mode&0o077)))
      throw error('TARGET_CHANGED','系统收纳目录不可用或不是私有目录');
    return {path:directory,identity:directoryIdentity(st),privateOnly};
  }
  basePath(kind,scope='library') {
    this.assertAvailable();
    if(!kinds.includes(kind))throw error('INVALID_DESTINATION','素材类型无效',400);
    const base=path.join(this.directory,scope==='project'?'picture':rootNames[kind]);
    const roots=this.lib.allRoots(), overlapping=roots.filter(r=>within(r.path,base)||within(base,r.path));
    if(overlapping.some(r=>r.retired)) throw error('TARGET_RETIRED','目标所属目录已注销，请先明确恢复管理');
    if(overlapping.some(r=>r.path!==base || r.kind!==kind)) throw error('TARGET_CHANGED','系统目标必须以原路径和准确类型独立登记');
    return base;
  }
  async readBase(kind,scope='library') {
    const base=this.basePath(kind,scope),proofs=[this.anchor];assertDirectories(proofs);
    for(const dir of [this.directory,base]) {
      const present=await fs.lstat(dir).catch(e=>e.code==='ENOENT'?null:Promise.reject(e));
      if(!present){assertDirectories(proofs);return{base,proofs,exists:false};}
      proofs.push(await this.ensureDirectory(dir,{privateOnly:dir===base&&scope==='library',create:false}));assertDirectories(proofs);
    }
    return {base,proofs,exists:true};
  }
  async projectImageDirectory(base,project,exists=true) {
    const entries=exists?(await fs.readdir(base)).filter(n=>n.endsWith('--'+project.id.toLowerCase())):[];
    if(entries.length>1)throw error('TARGET_CHANGED','同一项目存在多个图片目录，请先核对');
    return path.join(base,entries[0]??projectFolderName(project));
  }
  async previewImageTarget(value) {
    const d=destination(value),project=this.project(d.projectId,true);
    const ids=imageIds(d,'preview');
    const asset=imageGuard(this,this.imageTarget({destination:d,imageIds:ids,requestGroupId:'preview'}));
    const state=await this.readBase('photo','project');
    const target=await this.projectImageDirectory(state.base,project,state.exists);
    assertDirectories(state.proofs);
    return {target,destination:d,assetName:asset?.name,verify:()=>assertDirectories(state.proofs)};
  }
  async previewLibraryTarget(value) {
    const d=destination(value);
    const state=await this.readBase(d.kind);
    let target=state.base;
    for(const name of d.directory.split('/').filter(Boolean)) {
      target=path.join(target,name);
      state.proofs.push(await this.ensureDirectory(target,{create:false}));
    }
    const verify=()=>assertDirectories(state.proofs);
    verify();
    return {target,verify};
  }
  async base(kind,scope='library') {
    this.writable();
    const base=this.basePath(kind,scope);
    const parent=await this.ensureDirectory(this.directory), directory=await this.ensureDirectory(base,{privateOnly:scope==='library'});
    // addRoot intentionally restores retired roots; generic intake must never
    // do so. Register synchronously with the final overlap check in one tx.
    let added=false;
    const root=this.assets.tx(()=>{
      assertDirectories([this.anchor,parent,directory]);
      const current=this.lib.allRoots().filter(r=>within(r.path,base)||within(base,r.path));
      if(current.some(r=>r.retired)) throw error('TARGET_RETIRED','目标目录已注销，未自动恢复');
      if(current.some(r=>r.path!==base || r.kind!==kind)) throw error('TARGET_CHANGED','原目录位置或类型已变化');
      if(current[0]) return current[0];
      if(within(base,this.dataDir)||within(this.dataDir,base)) throw error('TARGET_CHANGED','不能登记应用数据目录或其上级');
      const id=randomUUID(),now=Date.now(),order=Number(this.db.prepare('SELECT MAX(management_order) n FROM roots').get().n||0)+1;
      this.db.prepare('INSERT INTO roots(id,path,kind,name,managed_added_ms,management_order) VALUES(?,?,?,?,?,?)').run(id,base,kind,path.basename(base),now,order);
      added=true;return this.db.prepare('SELECT * FROM roots WHERE id=?').get(id);
    });
    if(added) await this.onRootAdded(root);
    if(root.path!==base || root.kind!==kind || root.retired) throw error('TARGET_CHANGED','目录登记类型或位置不同');
    return {root,rootProof:rootProof(root),rootIdentity:await rootIdentity(root),proofs:[this.anchor,parent,directory],base};
  }
  async prepare(value,{sharedImages,requestGroupId}={}) {return this.serial(async()=>{
    const d=destination(value);
    if(sharedImages!==undefined && !(sharedImages instanceof Map)) throw error('INVALID_DESTINATION','本批图片分配表无效',400);
    if(requestGroupId!==undefined && !uuid(requestGroupId)) throw error('INVALID_REQUEST_ID','批次编号无效',400);
    let group=requestGroupId;
    if(sharedImages) {
      const prior=sharedImages.get('managed-intake:requestGroupId');
      if(prior && group && prior!==group) throw error('INVALID_REQUEST_ID','本批图片分配表属于另一批次',400);
      group??=prior??randomUUID();sharedImages.set('managed-intake:requestGroupId',group);
    }
    group??=randomUUID();
    const target={version:1,libraryId:this.libraryId,destination:d,requestGroupId:group};
    let project;
    if(d.scope==='project') {
      project=this.project(d.projectId,true);
      target.imageIds=imageIds(d,group);
      const asset=imageGuard(this,this.imageTarget(target));
      if(d.assetKind)target.assetName=asset.name;
    }
    Object.assign(target,await this.base(d.kind,d.scope));
    let directory=target.base;
    if(project) {
      directory=await this.projectImageDirectory(directory,project);
      target.proofs.push(await this.ensureDirectory(directory));
    } else for(const name of d.directory.split('/').filter(Boolean)) {
      directory=path.join(directory,name);target.proofs.push(await this.ensureDirectory(directory,{create:false}));
    }
    target.target=directory;target.targetIdentity=target.proofs.at(-1).identity;
    target.label=project ? project.name+' / '+(d.assetKind?target.assetName:d.characterName+' / '+d.lookName) : labels[d.kind]+' / '+(d.directory||'待确认');
    await this.current(target);return structuredClone(target);
  });}
  async choices(kind,directory='',{readOnly=false}={}) {return this.serial(async()=>{
    if(!kinds.includes(kind)) throw error('INVALID_DESTINATION','素材类型无效',400);
    relativeDirectory(directory);
    const state=await (readOnly?this.readBase(kind):this.base(kind)), folders=[{id:'',name:'待确认',relativePath:''}];
    const walk=async(base,prefix,depth)=>{
      for(const e of await fs.readdir(base,{withFileTypes:true})) {
        if(!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith('.')) continue;
        try {validName(e.name);} catch {continue;}
        const file=path.join(base,e.name), relative=prefix?prefix+'/'+e.name:e.name;
        const proof=await this.ensureDirectory(file,{create:false});assertDirectories([...state.proofs,proof]);
        folders.push({id:relative,name:relative,relativePath:relative});
        if(depth<2) await walk(file,relative,depth+1);
      }
    };
    if(state.exists!==false)await walk(state.base,'',1);assertDirectories(state.proofs);
    if(directory && !folders.some(f=>f.id===directory)) throw error('TARGET_CHANGED','目标分类已不存在');
    return {folders:folders.sort((a,b)=>a.relativePath.localeCompare(b.relativePath,'zh-CN'))};
  });}
  async createFolder(kind,{directory='',name}={}) {return this.serial(async()=>{
    if(!kinds.includes(kind)) throw error('INVALID_DESTINATION','素材类型无效',400);
    const relative=relativeDirectory(directory), child=validName(name), next=relativeDirectory(relative?relative+'/'+child:child);
    const state=await this.base(kind);let parent=state.base;
    for(const part of relative.split('/').filter(Boolean)) {
      parent=path.join(parent,part);
      const st=await fs.lstat(parent);state.proofs.push({path:parent,identity:directoryIdentity(st)});
      assertDirectories(state.proofs);
    }
    if((await fs.readdir(parent)).some(n=>nameKey(n)===nameKey(child))) throw error('FOLDER_EXISTS','同名目录已存在');
    assertDirectories(state.proofs);await fs.mkdir(path.join(parent,child),{mode:0o700});assertDirectories(state.proofs);
    await this.ensureDirectory(path.join(parent,child));return {id:next,name:next,relativePath:next};
  });}
  currentSync(target,{image=true,write=true}={}) {
    this.assertTargetLibrary(target);
    if(write)this.writable();
    if(!target || target.version!==1 || !uuid(target.requestGroupId) || canonical(destination(target.destination))!==canonical(target.destination)) throw error('TARGET_CHANGED','固定目标无效');
    const d=target.destination, expectedBase=path.join(this.directory,d.scope==='project'?'picture':rootNames[d.kind]);
    if(target.base!==expectedBase || target.root.path!==expectedBase || target.root.kind!==d.kind || !within(expectedBase,target.target)) throw error('TARGET_CHANGED','目标不属于原系统目录');
    const root=this.lib.roots().find(r=>r.id===target.root.id);
    if(rootProof(root)!==target.rootProof || root?.online===0) throw error('TARGET_CHANGED','原登记根已注销、改类型或移动');
    assertDirectories([this.anchor,...target.proofs]);
    const first=target.proofs.find(p=>p.path===expectedBase),last=target.proofs.at(-1);
    if(!first || !last || last.path!==target.target || !sameDirectory(last.identity,target.targetIdentity) || target.rootIdentity!==first.identity.dev+':'+first.identity.ino)
      throw error('TARGET_CHANGED','固定目录证明不完整');
    if(d.scope==='library' && path.join(expectedBase,d.directory)!==target.target) throw error('TARGET_CHANGED','目标分类与固定目录不一致');
    if(d.scope==='project') {
      this.project(d.projectId,true);
      if(path.dirname(target.target)!==expectedBase || !path.basename(target.target).endsWith('--'+d.projectId.toLowerCase()) || canonical(target.imageIds)!==canonical(imageIds(d,target.requestGroupId))) throw error('TARGET_CHANGED','项目图片固定目录或分配编号不同');
      if(image) imageGuard(this,this.imageTarget(target));
    }
    return target;
  }
  async current(target,options) {this.currentSync(target,options);if(await rootIdentity(target.root)!==target.rootIdentity) throw error('TARGET_CHANGED','原目录根身份不同');this.currentSync(target,options);return target;}
  read(target,id) {
    this.assertAvailable();
    const s=this.receipts.read(id);
    this.assertReceiptLibrary(s);
    if(target) this.assertTargetLibrary(target);
    if(target && canonical(s.target)!==canonical(target)) throw error('REQUEST_ID_CONFLICT','回执不属于固定目标');
    return s;
  }
  receiptDTO(s) {
    this.assertReceiptLibrary(s);
    return {id:s.id,status:s.status,assetId:s.assetId,creativeAssetId:s.creativeAssetId,lookId:s.lookId,bindingId:s.bindingId,
      fileName:s.finalName||s.fileName,error:s.error,candidates:(s.candidates||[]).map(c=>({id:c.id,name:c.name,reason:c.reason,
        mediaUrl:`/api/file-intake/media-imports/${s.id}/candidates/${c.id}/media`}))};
  }
  bind(value,target) {
    this.assertTargetLibrary(target);
    if(canonical(destination(value))!==canonical(target?.destination)) throw error('TARGET_CHANGED','收纳目标与确认时不同');
    // Own the snapshot: a caller changing an input object cannot redirect work.
    const bound=structuredClone(target),owner=this;
    const placeholder=id=>{owner.assertTargetLibrary(bound);if(bound.destination.scope==='project' && id && id!==bound.destination.projectId) throw error('TARGET_CHANGED','项目编号与固定目标不同');};
    return {
      lib:this.lib,db:this.db,media:this.media,running:this.running,instance:this.instance,
      project(id,write=false){placeholder(id);return bound.destination.scope==='project'?owner.project(bound.destination.projectId,write):{id:'',name:labels[bound.destination.kind]};},
      async current(id,state=bound,options){placeholder(id);if(canonical(state)!==canonical(bound)) throw error('TARGET_CHANGED','不能替换已确认目标');return owner.current(bound,options);},
      startIntake(id,input,state=bound){placeholder(id);if(canonical(state)!==canonical(bound)) throw error('TARGET_CHANGED','不能替换已确认目标');return owner.start(bound,input);},
      upload(id,requestId,stream){placeholder(id);return owner.upload(bound,requestId,stream);},
      receipt(id,requestId){placeholder(id);return owner.read(bound,requestId);},
      receiptDTO(s){if(canonical(s.target)!==canonical(bound)) throw error('REQUEST_ID_CONFLICT','回执固定目标不同');return owner.receiptDTO(s);},
      resolve(id,requestId,input){placeholder(id);return owner.resolve(bound,requestId,input);},
      verifiedSource(id,assetId){placeholder(id);return owner.verifiedSource(bound,assetId);},
      assertIntakeBinding(id,requestId){
        if(bound.destination.scope!=='project')return;
        placeholder(id);
        const receipt=owner.read(bound,requestId);
        owner.currentSync(bound,{image:false});
        owner.assertResultBinding(receipt);
      },
      hash(file,expected){owner.assertTargetLibrary(bound);return owner.hash(file,expected);},
      cleanupIntakeStage(id,requestId){placeholder(id);return owner.cleanup(bound,requestId);}
    };
  }
  async start(target,input) {return this.serial(async()=>{
    this.assertTargetLibrary(target);
    if(!uuid(input?.requestId)) throw error('INVALID_REQUEST_ID','请求编号无效',400);
    const name=validName(input.fileName),fileName=target.destination.fileName??name;
    if(kindForExt(path.extname(name).slice(1),target.destination.kind)!==target.destination.kind || path.extname(fileName).toLowerCase()!==path.extname(name).toLowerCase() || !Number.isSafeInteger(input.bytes) || input.bytes<1)
      throw error('INVALID_MEDIA','文件类型、扩展名或长度与目标不同',400);
    const args=digest({target,input});let existing;
    try {existing=this.read(null,input.requestId);} catch(e) {if(e.code!=='IMPORT_NOT_FOUND') throw e;}
    if(existing) {if(existing.args!==args) throw error('REQUEST_ID_CONFLICT','请求编号已用于其他输入');return this.receiptDTO(existing);}
    await this.current(target);
    const s={version:1,id:input.requestId,library:this.dataDir,libraryId:this.libraryId,target:structuredClone(target),args,fileName,bytes:input.bytes,
      ids:{mediaId:allocatedId(input.requestId+':media'),bindingId:allocatedId(input.requestId+':binding'),...target.imageIds},
      status:'waiting',instance:this.instance,createdAt:Date.now()};
    this.persist(s,{exclusive:true});return this.receiptDTO(s);
  });}
  async hash(file,expected) {
    this.assertAvailable();
    const opened=await this.media.open({path:file,identity:expected});
    try {
      const hash=createHash('sha256');
      for await(const chunk of opened.handle.createReadStream({autoClose:false})) {this.writable();hash.update(chunk);}
      await this.verifyHeld(file,opened);return {hash:hash.digest('hex'),identity:opened.identity};
    } finally {await this.media.release(opened.handle);}
  }
  async verifyHeld(file,opened) {
    if(!same(stamp(await opened.handle.stat()),opened.identity) || !same(stamp(await fs.lstat(file)),opened.identity) || await fs.realpath(file)!==file)
      throw error('SOURCE_CHANGED','文件或其路径在核验期间发生变化');
  }
  durabilityProof(s,file,identity,hash) {
    return {version:1,path:file,identity,hash,target:digest(s.target)};
  }
  assertDurable(s,file=s.resultPath,identity=s.resultIdentity,hash=s.resultHash) {
    // A legacy ready/commit journal proves registration, not that copyOnly's
    // final file and directory entries were synced. Never upgrade it on read.
    if(!s.durability || canonical(s.durability)!==canonical(this.durabilityProof(s,file,identity,hash)))
      throw error('SOURCE_UNTRUSTED','正式副本缺少文件及目录同步证明；原件与接收副本保留');
  }
  async syncPublished(s,file,opened,d) {
    await this.current(s.target);await this.verifyHeld(file,opened);
    await opened.handle.sync();
    await this.verifyHeld(file,opened);
    // Sync leaf first, then every pinned ancestor through the pre-existing
    // anchor. This also persists personal_item/type/project directories made
    // during prepare, without following links or recreating a changed target.
    const proofs=[...new Map([this.anchor,...s.target.proofs].map(p=>[p.path,p])).values()].reverse();
    for(const proof of proofs) {
      await this.current(s.target);
      const handle=await fs.open(proof.path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      try {
        const st=await handle.stat();
        if(!st.isDirectory() || !sameDirectory(directoryIdentity(st),proof.identity)) throw error('TARGET_CHANGED','同步目录不是原固定目标');
        await handle.sync();
        if(!sameDirectory(directoryIdentity(await handle.stat()),proof.identity)) throw error('TARGET_CHANGED','同步期间目录身份已变化');
        await this.current(s.target);
      } finally {await handle.close();}
    }
    await this.verifyHeld(file,opened);await this.current(s.target);
    return this.durabilityProof(s,file,d.identity,d.hash);
  }
  async upload(target,id,stream) {
    const s=this.read(target,id);
    if(s.status!=='waiting' || s.instance!==this.instance || this.running.has(id)) throw error('IMPORT_BUSY','原请求已接收或中断，不能重发');
    this.running.add(id);let handle;
    try {
      await this.current(target);s.status='uploading';this.persist(s);
      // Reuse the established cwd-pinned publishing worker. Its accepted stage
      // prefix is intentionally unchanged, and copyOnly prevents a hard link to
      // the temporary receive file for every kind, including photos and audio.
      s.cache=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'shiguang-project-video-import-')));
      await fs.chmod(s.cache,0o700);s.cacheIdentity=directoryIdentity(await fs.lstat(s.cache));s.stage=path.join(s.cache,'original.partial');
      this.persist(s);handle=await fs.open(s.stage,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      const hash=createHash('sha256');let bytes=0;
      for await(const chunk of stream) {
        await this.current(target);bytes+=chunk.length;
        if(bytes>s.bytes) throw error('INVALID_LENGTH','接收长度超出原文件');
        await handle.writeFile(chunk);hash.update(chunk);
      }
      if(bytes!==s.bytes) throw error('INVALID_LENGTH','原文件未完整接收');
      await handle.sync();await handle.close();handle=null;
      s.hash=hash.digest('hex');s.stageStat=stamp(await fs.lstat(s.stage));
      return await this.serial(async()=>{
        await this.current(target);s.candidates=await this.candidates(s);
        if(s.candidates.length) {s.status='duplicate';this.persist(s);return this.receiptDTO(s);}
        return this.publish(s,false);
      });
    } catch(e) {this.failed(s,e);throw e;}
    finally {await handle?.close();this.running.delete(id);}
  }
  failed(s,e) {s.status=s.publicationAttempt || s.commit?'unknown':'failed';s.error=e.message;try {this.persist(s);} catch { /* Original durable intent remains authoritative. */ }}
  async candidates(s) {
    const result=[];
    for(const e of await fs.readdir(s.target.target,{withFileTypes:true})) {
      if(e.name.startsWith('.') || !e.isFile() || kindForExt(path.extname(e.name).slice(1),s.target.destination.kind)!==s.target.destination.kind) continue;
      const file=path.join(s.target.target,e.name), st=await fs.lstat(file),sameName=nameKey(e.name)===nameKey(s.fileName);
      if(!sameName && st.size!==s.bytes) continue;
      const d=await this.hash(file);
      if(sameName || d.hash===s.hash) result.push({id:randomUUID(),file,name:e.name,hash:d.hash,identity:d.identity,
        asset:assetProof(this.db.prepare('SELECT * FROM assets WHERE path=?').get(file)),reason:sameName?'同名文件':'相同内容'});
    }
    return result;
  }
  async worker(script,metadata,cwd) {
    const child=spawn(process.execPath,[script,JSON.stringify(metadata)],{cwd,env:{PATH:process.env.PATH||''},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',spawnError;
    const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
    this.media.children.add(child);this.media.exits.set(child,closed);
    child.stdout.on('data',b=>{if(stdout.length<8192) stdout+=b;});child.stderr.on('data',b=>{if(stderr.length<8192) stderr+=b;});child.once('error',e=>{spawnError=e;});
    try {const end=await closed;if(spawnError || end.code!==0 || end.signal) throw error('MEDIA_COPY_UNSETTLED',stderr||'保存进程结果未确认，原件与副本保留');return JSON.parse(stdout);}
    finally {this.media.children.delete(child);this.media.exits.delete(child);}
  }
  async publish(s,suffixed) {
    await this.current(s.target);
    const staged=await this.hash(s.stage,s.stageStat);
    if(staged.hash!==s.hash) throw error('SOURCE_CHANGED','接收副本已变化');
    s.publicationAttempt=true;s.status='publishing';this.persist(s);
    const lock='managed-intake:'+s.id;this.lib.locks.add(lock);
    try {
      const result=await this.worker(path.join(import.meta.dirname,'../project-videos/publish-worker.mjs'),{
        directory:{dev:Number(s.target.targetIdentity.dev),ino:Number(s.target.targetIdentity.ino)},
        stage:s.stage,stageIdentity:[s.stageStat.dev,s.stageStat.ino,s.stageStat.size,s.stageStat.mtimeMs,s.stageStat.ctimeMs].join(':'),
        fileName:s.fileName,suffixed,copyOnly:true},s.target.target);
      const name=validName(result.fileName);
      s.published=path.join(s.target.target,name);this.persist(s);
      await this.current(s.target);const d=await this.hash(s.published);
      if(d.hash!==s.hash || d.identity.dev===s.stageStat.dev && d.identity.ino===s.stageStat.ino) throw error('MEDIA_COPY_CHANGED','正式文件不是完整独立副本');
      return await this.register(s,s.published,d);
    } finally {this.lib.locks.delete(lock);}
  }
  async resolve(target,id,input) {return this.serial(async()=>{
    const s=this.read(target,id);
    if(!['import','rename','reuse','cancel'].includes(input?.choice)) throw error('INVALID_CHOICE','请选择另存、复用或取消；通用收纳不能覆盖',400);
    if(s.status==='ready') return this.receiptDTO(s);
    if(this.running.has(id) || !['duplicate','waiting'].includes(s.status)) throw error('IMPORT_BUSY','原请求不能再次执行');
    if(input.choice==='cancel') {s.status='cancelled';s.error=null;this.persist(s);return this.receiptDTO(s);}
    if(s.status!=='duplicate') throw error('IMPORT_BUSY','请先完整接收文件');
    this.running.add(id);
    try {
      await this.current(target);
      if(input.choice==='import' || input.choice==='rename') {
        if(input.fileName!==undefined) {
          const name=validName(input.fileName);
          if(path.extname(name).toLowerCase()!==path.extname(s.fileName).toLowerCase()) throw error('INVALID_MEDIA','另存名称必须保留原扩展名',400);
          s.fileName=name;
        }
        return await this.publish(s,true);
      }
      const candidate=s.candidates.find(c=>c.id===input.candidateId);
      if(!candidate) throw error('INVALID_CHOICE','请选择原回执中的候选',400);
      if(assetProof(this.db.prepare('SELECT * FROM assets WHERE path=?').get(candidate.file))!==candidate.asset) throw error('MEDIA_CONFLICT','候选的原登记或分类已变化');
      const d=await this.hash(candidate.file,candidate.identity);
      if(d.hash!==candidate.hash) throw error('SOURCE_CHANGED','候选内容已变化');
      s.reused=true;return await this.register(s,candidate.file,d);
    } catch(e) {this.failed(s,e);throw e;}
    finally {this.running.delete(id);}
  });}
  assertAsset(a,s,file,d) {
    if(a && (a.trashed || a.kind!==s.target.destination.kind || a.root_id!==s.target.root.id || a.path!==file ||
        String(a.dev)!==d.identity.dev || String(a.ino)!==d.identity.ino || a.size!==d.identity.size || a.mtime!==d.identity.mtimeMs || a.sha256 && a.sha256!==d.hash))
      throw error('MEDIA_CONFLICT','原素材身份、类型或登记根已变化，未认领或改写');
  }
  async register(s,file,d) {
    await this.current(s.target);
    if(path.dirname(file)!==s.target.target) throw error('TARGET_CHANGED','候选不是原固定目录的文件');
    const opened=await this.media.open({path:file,identity:d.identity});
    try {
      const old=this.db.prepare('SELECT * FROM assets WHERE path=?').get(file);this.assertAsset(old,s,file,d);
      const mediaId=old?.id??s.ids.mediaId, beforeProof=assetProof(old);
      let previous,prepared;
      if(s.target.destination.scope==='project') {
        previous=imageGuard(this,this.imageTarget(s.target));
        // Reuse ProjectAssets.prepare with an inspector for just the held new
        // file. Inserting a row before its async preparation would break atomic
        // registration + binding. All previous images use the real inspector.
        const preparer=Object.create(this.assets);
        preparer.inspect=async(id,...args)=>id===mediaId ? {state:'available',sha256:d.hash,name:path.basename(file)} : this.assets.inspect(id,...args);
        prepared=await preparer.prepare(bindingInput(this.imageTarget(s.target),previous,mediaId,s.ids.bindingId),previous);
      }
      s.durability=await this.syncPublished(s,file,opened,d);
      const commit={assetId:mediaId,path:file,identity:d.identity,hash:d.hash,
        creativeId:prepared?.id,revision:prepared?(previous?.revision??0)+1:undefined,contentHash:prepared?digest(contentOf(prepared)):undefined};
      s.commit=commit;s.status='committing';this.persist(s);
      this.assets.tx(()=>{
        if (prepared) this.assets.lockDirectory();
        this.currentSync(s.target);
        if(!same(stamp(fsSync.fstatSync(opened.handle.fd)),opened.identity) || !same(stamp(fsSync.lstatSync(file)),opened.identity) || fsSync.realpathSync(file)!==file) throw error('SOURCE_CHANGED','文件在登记前变化');
        if(assetProof(this.db.prepare('SELECT * FROM assets WHERE path=?').get(file))!==beforeProof) throw error('MEDIA_CONFLICT','素材登记或分类在准备期间变化');
        if(prepared) {
          const current=imageGuard(this,this.imageTarget(s.target),{lock:true});
          if(canonical(current)!==canonical(previous)) throw error('IMAGE_TARGET_CONFLICT','人物或造型在准备期间变化');
        }
        if(!old) {
          const cls=directoryClass(s.target.root,file), ids=indexFileIdentity(fsSync.fstatSync(opened.handle.fd));
          this.db.prepare('INSERT INTO assets(id,root_id,path,name,ext,kind,size,mtime,created_ms,category,sub,basis,review,dev,ino,sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(mediaId,s.target.root.id,file,path.basename(file),path.extname(file).slice(1).toLowerCase(),s.target.destination.kind,
              d.identity.size,d.identity.mtimeMs,Date.now(),cls.category,cls.sub,'通用文件收纳',cls.review,ids.dev,ids.ino,d.hash);
        } else if(!old.sha256) this.db.prepare('UPDATE assets SET sha256=? WHERE id=?').run(d.hash,mediaId);
        this.lib.directoryClassification?.sync(s.target.root.id,mediaId);
        if(prepared) {
          const result=this.assets.write(prepared,previous,'收纳项目图片');
          s.creativeAssetId=result.id;s.lookId=s.ids.lookId;s.bindingId=s.ids.bindingId;s.afterFingerprint=digest(result);
        }
        this.currentSync(s.target,{image:false});
        if(!same(stamp(fsSync.fstatSync(opened.handle.fd)),opened.identity) || !same(stamp(fsSync.lstatSync(file)),opened.identity) || fsSync.realpathSync(file)!==file)
          throw error('SOURCE_CHANGED','文件在绑定期间变化');
      });
      await this.verifyHeld(file,opened);this.currentSync(s.target,{image:false});
      s.assetId=mediaId;s.resultIdentity=d.identity;s.resultHash=d.hash;s.resultPath=file;s.finalName=path.basename(file);s.status='ready';s.error=null;
      this.persist(s);return this.receiptDTO(s);
    } finally {await this.media.release(opened.handle);}
  }
  async recover(s) {
    this.assertReceiptLibrary(s);
    const c=s.commit;await this.current(s.target,{image:false});
    this.assertDurable(s,c.path,c.identity,c.hash);
    const d=await this.hash(c.path,c.identity);
    if(d.hash!==c.hash) throw error('SOURCE_CHANGED','事务副本摘要不同');
    const a=this.db.prepare('SELECT * FROM assets WHERE id=?').get(c.assetId);this.assertAsset(a,s,c.path,d);
    if(!a || a.sha256!==c.hash) throw error('MEDIA_CONFLICT','事务登记尚未核清');
    if(c.creativeId) {
      const result=this.assets.get(c.creativeId);
      if(result.revision!==c.revision || digest(contentOf(result))!==c.contentHash || !result.images.some(b=>b.id===s.ids.bindingId && b.media_asset_id===a.id && b.look_id===s.ids.lookId)) throw error('IMAGE_TARGET_CONFLICT','绑定事务未核清');
      s.creativeAssetId=result.id;s.lookId=s.ids.lookId;s.bindingId=s.ids.bindingId;s.afterFingerprint=digest(result);
    }
    s.assetId=a.id;s.resultIdentity=d.identity;s.resultHash=d.hash;s.resultPath=c.path;s.finalName=path.basename(c.path);s.status='ready';s.error=null;this.persist(s);
  }
  async verifiedSource(target,assetId) {
    this.assertTargetLibrary(target);
    if(!uuid(assetId)) throw error('SOURCE_UNTRUSTED','素材编号无效');
    const receipts=this.receipts.list().filter(s=>this.ownsReceipt(s) && s.status==='ready' && s.assetId===assetId && canonical(s.target)===canonical(target));
    const s=receipts.sort((a,b)=>a.createdAt-b.createdAt).at(-1);if(!s) throw error('SOURCE_UNTRUSTED','没有此固定目标的成功回执');
    this.assertDurable(s);
    await this.current(target,{image:false});
    const a=this.db.prepare('SELECT * FROM assets WHERE id=?').get(assetId),d=await this.hash(s.resultPath,s.resultIdentity);
    if(!a || d.hash!==s.resultHash || a.sha256!==s.resultHash || assetProof(this.db.prepare('SELECT * FROM assets WHERE id=?').get(assetId))!==assetProof(a)) throw error('SOURCE_UNTRUSTED','正式文件或原登记未通过成功回执核验');
    this.assertAsset(a,s,s.resultPath,d);
    await this.current(target,{image:false});
    this.assertResultBinding(s);
    return {path:s.resultPath,identity:d.identity,assetId};
  }
  assertResultBinding(receipt) {
    const {destination,imageIds}=receipt.target;
    if(destination.scope!=='project')return;
    const {assetId:projectAssetId,characterId,lookId}=imageIds;
    const expectedAssetId=projectAssetId??characterId;
    const binding=this.db.prepare('SELECT * FROM creative_image_bindings WHERE id=?').get(receipt.bindingId??'');
    const asset=this.db.prepare('SELECT id,project_id,kind,archived_at FROM creative_assets WHERE id=?').get(expectedAssetId);
    const look=lookId===null?null:this.db.prepare('SELECT * FROM creative_looks WHERE id=?').get(lookId);
    if(receipt.status!=='ready' || receipt.bindingId!==receipt.ids?.bindingId ||
        receipt.creativeAssetId!==expectedAssetId || receipt.lookId!==lookId ||
        !asset || asset.project_id!==destination.projectId || asset.kind!==(destination.assetKind??'character') || asset.archived_at ||
        (!destination.assetKind && (!look || look.archived_at!==null || look.asset_id!==asset.id)) ||
        !binding || binding.archived_at!==null || binding.asset_id!==asset.id || binding.look_id!==lookId ||
        binding.media_asset_id!==receipt.assetId || binding.expected_sha256!==receipt.resultHash)
      throw error('SOURCE_UNTRUSTED','原项目图片绑定已变化');
  }
  async openCandidate(requestId,candidateId) {
    const s=this.read(null,requestId), c=s.candidates?.find(c=>c.id===candidateId);
    if(s.status!=='duplicate' || !c || path.dirname(c.file)!==s.target.target) throw error('SOURCE_UNTRUSTED','原候选不存在或已处理',404);
    await this.current(s.target);
    const opened=await this.media.open({path:c.file,identity:c.identity});
    try {
      const hash=createHash('sha256');for await(const chunk of opened.handle.createReadStream({autoClose:false,start:0})) hash.update(chunk);
      if(hash.digest('hex')!==c.hash || assetProof(this.db.prepare('SELECT * FROM assets WHERE path=?').get(c.file))!==c.asset) throw error('SOURCE_CHANGED','原候选内容或登记已变化');
      await this.verifyHeld(c.file,opened);await this.current(s.target);
      return {handle:opened.handle,path:c.file,identity:opened.identity};
    } catch(e) {await this.media.release(opened.handle);throw e;}
  }
  async cleanup(target,id) {return this.serial(async()=>{
    const s=this.read(target,id);
    if(s.status!=='ready' || s.instance!==this.instance || !s.stage || s.stageCleanup?.complete) return;
    if(this.running.has(id) || this.media.handles.size || this.media.children.size || this.media.closes.size) throw error('INTAKE_STAGE_BUSY','接收副本仍在使用');
    const source=await this.verifiedSource(target,s.assetId),d=await this.hash(source.path,source.identity);
    if(d.hash!==s.resultHash || source.identity.dev===s.stageStat.dev && source.identity.ino===s.stageStat.ino) throw error('INTAKE_STAGE_UNVERIFIED','正式副本未通过独立核验');
    if(path.dirname(s.cache)!==await fs.realpath(os.tmpdir()) || !path.basename(s.cache).startsWith('shiguang-project-video-import-') || s.stage!==path.join(s.cache,'original.partial')) throw error('INTAKE_STAGE_CHANGED','接收目录位置不同');
    const st=await fs.lstat(s.cache);
    if(!st.isDirectory() || st.isSymbolicLink() || await fs.realpath(s.cache)!==s.cache || (process.getuid && st.uid!==process.getuid()) || (process.platform!=='win32' && (st.mode&0o077)) || !sameDirectory(directoryIdentity(st),s.cacheIdentity) || !same(stamp(await fs.lstat(s.stage)),s.stageStat)) throw error('INTAKE_STAGE_CHANGED','接收副本身份已变化');
    s.stageCleanup={planned:true};this.persist(s);
    const result=await this.worker(path.join(import.meta.dirname,'cleanup-worker.mjs'),{directory:s.cacheIdentity,stage:s.stageStat},s.cache);
    if(result.stageRemoved!==true) throw error('INTAKE_STAGE_UNSETTLED','接收副本收尾结果未确认');
    s.stageCleanup={complete:true};this.persist(s);
  });}
}
