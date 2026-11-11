import path from 'node:path';
import fs from 'node:fs/promises';
import {canonical,fault,idOK} from './model.mjs';
import {imageDigest} from './image-import.mjs';
import {VideoActionJournal} from '../project-videos/action-journal.mjs';

const LIMIT=50, TTL=120_000;
const reject=(code,message,status=409)=>{throw fault(message,status,{code});};
const signature=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
const dto=({bindingId,name})=>({bindingId,name});
const localUnavailable=()=>({available:false,code:'DESKTOP_UNAVAILABLE',reason:'本机桌面连接不可用'});
const terminal=(items,skipped)=>items.length?(skipped.length?'partial':'completed'):'failed';

function selection(input, withToken=false){
  if(!input||!idOK(input.requestId)||!['defaults','references'].includes(input.mode)||
    !Array.isArray(input.items)||!input.items.length||input.items.length>LIMIT||
    Object.keys(input).some(k=>!['requestId','mode','items',...(withToken?['previewToken']:[])].includes(k))||
    input.items.some(x=>!x||Object.keys(x).length!==2||!idOK(x.bindingId)||!Number.isSafeInteger(x.bindingRevision)||x.bindingRevision<1)||
    new Set(input.items.map(x=>x.bindingId.toLowerCase())).size!==input.items.length)
    reject('IMAGE_SELECTION_INVALID','请选择 1 至 50 条带当前版本的图片绑定',400);
  if(withToken&&!idOK(input.previewToken))reject('PREVIEW_REQUIRED','请先核对访达操作影响');
  return {...input,items:input.items.map(({bindingId,bindingRevision})=>({bindingId,bindingRevision}))};
}

export function currentImageBinding(store,bindingId,revision,{projectId,mode='references'}={}){
  if(!idOK(bindingId)||!Number.isSafeInteger(revision)||revision<1)reject('IMAGE_SELECTION_INVALID','图片绑定或版本无效',400);
  const row=store.db.prepare('SELECT id,asset_id FROM creative_image_bindings WHERE id=?').get(bindingId);
  if(!row)reject('IMAGE_BINDING_STALE','图片绑定已变化，请重新读取');
  const asset=store.get(row.asset_id),binding=asset.images.find(b=>b.id===row.id);
  if((projectId&&asset.project_id!==projectId)||!binding||binding.revision!==revision||binding.archived_at!==null||asset.archived_at||asset.kind!=='character')
    reject('IMAGE_BINDING_STALE','图片绑定已变化或不属于当前人物，请重新读取');
  const look=asset.looks.find(l=>l.id===binding.look_id&&l.archived_at===null);
  if(!look||mode==='defaults'&&(asset.default_look_id!==look.id||look.default_image_id!==binding.id))
    reject('IMAGE_BINDING_STALE','图片已不在当前造型或已不是代表图，请重新读取');
  return {asset,binding};
}

export function registeredPhoto(store,binding){
  const media=store.lib.asset(binding.media_asset_id),root=store.db.prepare('SELECT * FROM roots WHERE id=?').get(media.root_id);
  if(media.kind!=='photo'||media.trashed||!root||root.retired||root.online===0||!/^[0-9a-f]{64}$/.test(binding.expected_sha256))
    reject('IMAGE_UNAVAILABLE','原图不可用，请核对素材目录和图片绑定');
  return {...media,registeredRootPath:root.path};
}

export class ProjectAssetDesktopActions {
  constructor(store,native,{withActivity=fn=>fn(),enabled=true}={}){
    this.store=store;this.native=enabled?native:null;this.closing=new AbortController();
    this.journal=new VideoActionJournal({
      db:store.db,project:id=>store.project(id),media:{track:withActivity}
    },{imageActions:true});
    const mysql=store.db.kind==='mysql',id=mysql?'VARCHAR(36)':'TEXT',json=mysql?'LONGTEXT':'TEXT',time=mysql?'BIGINT':'INTEGER';
    store.db.exec(`CREATE TABLE IF NOT EXISTS project_asset_desktop_actions (id ${id} PRIMARY KEY,project_id ${id} NOT NULL,data_json ${json} NOT NULL,created_at ${time} NOT NULL,updated_at ${time} NOT NULL)${mysql?' ENGINE=InnoDB':''}`);
  }
  beginClose(){this.journal.closed=true;this.closing.abort();}
  async close(){this.beginClose();await this.journal.settle().catch(()=>{});}
  async capabilities(id){
    this.store.project(id);
    let cap;
    try{cap=await this.native?.capabilities();}catch{/* keep unavailable DTO */}
    return {version:1,maxSelection:LIMIT,clipboard:cap?.clipboard??localUnavailable(),revealMany:cap?.revealMany??localUnavailable()};
  }
  async require(id,key){
    const cap=(await this.capabilities(id))[key];
    if(!cap.available)reject(cap.code,cap.reason);
  }
  async check(id,input,s){
    const eligible=[],skipped=[],seen=new Set();let owner;
    for(const item of input.items){
      if(this.journal.closed)reject('ASSET_DESKTOP_CLOSING','图片模块正在关闭',503);
      let name;
      try{
        const {asset,binding}=currentImageBinding(this.store,item.bindingId,item.bindingRevision,{projectId:id,mode:input.mode});
        if(input.mode==='references'&&owner&&asset.id!==owner)reject('IMAGE_SELECTION_SCOPE','一次只能处理同一人物的参考图');
        if(input.mode==='references')owner=asset.id;
        const media=registeredPhoto(this.store,binding),file=await this.store.lib.checked(media.path,media.root_id);
        name=path.basename(file);
        const {hash,stat}=await imageDigest(file,{signal:AbortSignal.any([this.closing.signal,AbortSignal.timeout(8000)])});
        if(hash!==binding.expected_sha256)reject('IMAGE_CONTENT_CHANGED','原图内容与绑定不一致，请先核对');
        const physical=stat.dev+':'+stat.ino;
        if(seen.has(physical))reject('DUPLICATE_FILE_IN_SELECTION','与本次另一张图片是同一文件，只处理一次');
        seen.add(physical);
        eligible.push({...item,name,file,identity:signature(stat),sha256:hash,mediaId:media.id,rootId:media.root_id,registeredPath:media.path,registeredRootPath:media.registeredRootPath});
      }catch(e){
        skipped.push({bindingId:item.bindingId,...(name?{name}:{}),code:e.status&&e.code||'IMAGE_UNAVAILABLE',reason:e.status?e.message:'原图无法读取'});
      }
      s.progress.checked++;this.journal.save(s);
      if(this.journal.closed)reject('ASSET_DESKTOP_CLOSING','图片模块正在关闭',503);
    }
    return {eligible,skipped};
  }
  checkAuthority(id,input,item){
    const {binding}=currentImageBinding(this.store,item.bindingId,item.bindingRevision,{projectId:id,mode:input.mode}),media=registeredPhoto(this.store,binding);
    if(media.id!==item.mediaId||media.root_id!==item.rootId||media.path!==item.registeredPath||media.registeredRootPath!==item.registeredRootPath||binding.expected_sha256!==item.sha256)
      reject('PREVIEW_STALE','图片或素材目录已变化，请重新核对');
    return media;
  }
  async recheck(id,input,items){
    for(const item of items){
      const media=this.checkAuthority(id,input,item),file=await this.store.lib.checked(media.path,media.root_id);
      const stat=await fs.lstat(file);
      if(file!==item.file||!stat.isFile()||signature(stat)!==item.identity||await fs.realpath(file)!==file)
        reject('PREVIEW_STALE','图片文件已变化，请重新核对');
    }
    if(this.journal.closed)reject('ASSET_DESKTOP_CLOSING','图片模块正在关闭',503);
    for(const item of items)this.checkAuthority(id,input,item);
  }
  status(id,requestId){return this.journal.dto(this.journal.row(id,requestId));}
  async dispatch(s,eligible,key,options){
    s.status='running';s.dispatched=true;this.journal.save(s);
    try{
      const ack=await this.native[key](eligible.map(x=>x.file),options);
      if(ack?.ack!==(key==='copyFiles'?'written':'dispatched')||ack.count!==eligible.length)
        reject('DESKTOP_ACK_UNKNOWN','桌面操作尚未取得最终回执，请查询原请求');
      return ack.ack;
    }catch(e){
      if(e.effectUnknown===false){s.dispatched=false;this.journal.save(s);}
      if(e.code==='CLIPBOARD_CHANGED')throw fault('剪贴板在核对期间已变化，未覆盖新内容',409,{code:e.code});
      if(e.status)throw e;
      throw fault(s.dispatched?'桌面操作尚未取得最终回执，请查询原请求':'桌面操作未完成',409,{code:e.code||'ASSET_DESKTOP_FAILED'});
    }
  }
  base(s,skipped){
    return {requestId:s.requestId,projectId:s.projectId,action:s.action,requestedCount:s.progress.total,skipped};
  }
  clipboard(id,body){
    const input=selection(body);
    return this.journal.start(id,'clipboard',input,async(s,admitted)=>{
      await this.require(id,'clipboard');
      const expectedChangeCount=await admitted,{eligible,skipped}=await this.check(id,input,s);
      const base=this.base(s,skipped);
      if(!eligible.length)return {...base,status:'failed',copied:[],count:0,code:'NO_VALID_FILES'};
      await this.recheck(id,input,eligible);
      const ack=await this.dispatch(s,eligible,'copyFiles',{expectedChangeCount,beforeDispatch:()=>this.recheck(id,input,eligible)});
      return {...base,status:terminal(eligible,skipped),copied:eligible.map(dto),count:eligible.length,ack};
    },()=>this.native?.clipboardVersion());
  }
  revealPreview(id,body){
    const input=selection(body);
    return this.journal.start(id,'reveal-preview',input,async s=>{
      await this.require(id,'revealMany');
      const {eligible,skipped}=await this.check(id,input,s);
      await this.recheck(id,input,eligible);
      const directories=new Map();
      for(const image of eligible){const dir=path.dirname(image.file);directories.set(dir,(directories.get(dir)||0)+1);}
      const folders=[...directories].map(([dir,count],i)=>({key:String(i),label:path.basename(dir)||'原图所在目录',count}));
      const base={...this.base(s,skipped),status:terminal(eligible,skipped),eligible:eligible.map(dto),folderCount:folders.length,folders};
      if(!eligible.length)return {...base,code:'NO_VALID_FILES'};
      const expiresAt=Date.now()+TTL;
      s.preview={expiresAt,selection:canonical([input.mode,input.items]),eligible,skipped,folders};
      return {...base,previewToken:s.requestId,expiresAt};
    });
  }
  reveal(id,body){
    const input=selection(body,true);
    return this.journal.start(id,'reveal',input,async s=>{
      let original;
      try{original=this.journal.row(id,input.previewToken);}catch{reject('PREVIEW_STALE','访达核对已失效，请重新核对');}
      const preview=original.preview;
      if(original.action!=='reveal-preview'||!['completed','partial'].includes(original.status)||!preview||
        preview.expiresAt<=Date.now()||preview.selection!==canonical([input.mode,input.items]))
        reject('PREVIEW_STALE','访达核对已过期或选择变化，请重新核对');
      await this.require(id,'revealMany');
      try{await this.recheck(id,input,preview.eligible);}catch(e){
        if(e.code==='ASSET_DESKTOP_CLOSING')throw e;
        reject('PREVIEW_STALE','图片或绑定在核对后变化，请重新核对');
      }
      const ack=await this.dispatch(s,preview.eligible,'revealFiles',{beforeDispatch:()=>this.recheck(id,input,preview.eligible)});
      return {...this.base(s,preview.skipped),status:terminal(preview.eligible,preview.skipped),requested:preview.eligible.map(dto),count:preview.eligible.length,folderCount:preview.folders.length,ack};
    });
  }
}
