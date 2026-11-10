import {mediaContentFingerprintCapability} from './content-identity.mjs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical,idOK} from '../project-assets/model.mjs';
import {fail} from '../storyboard-video/model.mjs';

const idsFor=input=>{
  if(!Array.isArray(input?.ids)||!input.ids.length||input.ids.length>50||input.ids.some(id=>!idOK(id)))fail('VIDEO_SELECTION_INVALID','请选择1至50个当前项目的视频');
  if(Object.keys(input).some(k=>!['requestId','ids','previewToken'].includes(k)))fail('INVALID_INPUT','桌面操作只接受项目视频编号');
  return [...new Set(input.ids)];
};
const unavailable=(code,reason)=>({available:false,code,reason});

export class ProjectVideoDesktopActions {
  constructor(catalog,native,journal){this.catalog=catalog;this.native=native;this.journal=journal;}
  async capabilities(){
    let native;try{native=await this.native.capabilities();}catch{native={clipboard:unavailable('DESKTOP_UNAVAILABLE','本机桌面连接不可用'),revealMany:unavailable('DESKTOP_UNAVAILABLE','本机桌面连接不可用')};}
    return {version:1,maxSelection:50,...native,mediaIdentity:await mediaContentFingerprintCapability(this.catalog.media)};
  }
  async eligible(id,ids,s){
    const c=this.catalog,eligible=[],skipped=[],seen=new Set();
    for(const key of ids){
      if(c.media.closing)fail('VIDEO_CLOSING','视频模块正在关闭',503);
      let name;
      try {
        const source=await c.verifiedSource(id,key),m=c.metadata(id,source);name=m.data.title;
        const managed=c.isManaged(id,source);
        if(m.data.managed&&!managed)fail('SOURCE_UNTRUSTED','项目管理授权不完整，请明确重新定位',409);
        const physical=source.identity.dev+':'+source.identity.ino;
        if(seen.has(physical)){skipped.push({id:key,name,code:'DUPLICATE_FILE_IN_SELECTION',reason:'与本次另一个视频使用同一实际文件，只处理一次'});continue;}
        seen.add(physical);
        const locationContext=await c.verification.capture(id,key,{allowExternal:true});
        eligible.push({locationContext,id:key,name,path:source.path,identity:source.identity,revision:m.row?.revision||0,authority:c.verification.authority(id,key),managed,verification:c.verification.view(source)});
      }catch(e){skipped.push({id:key,...(name?{name}:{}),code:e.code==='SOURCE_CHANGED'?(c.verification.view(c.videos.source(id,key)).state==='content_changed'?'SOURCE_CONTENT_CHANGED':'SOURCE_NEEDS_VERIFICATION'):(e.code||'SOURCE_UNAVAILABLE'),reason:e.status?e.message:'无法读取此视频'});}
      if(s){s.progress.checked++;this.journal.save(s);}
    }
    return {eligible,skipped};
  }
  async validate(id,items){
    const c=this.catalog;c.project(id);
    for(const item of items){
      if(c.verification.authority(id,item.id)!==item.authority)fail('PREVIEW_STALE','视频或文件夹在核对后变化，请重新核对',409);
      await c.verification.checkLocation(item.locationContext);
      await c.media.verify({path:item.path,identity:item.identity});
      c.folders.busyOperations(id,item.path);
      if(c.verification.authority(id,item.id)!==item.authority)fail('PREVIEW_STALE','核验期间读取授权已变化',409);
      if(item.locationContext.external)continue;
      const folder=c.folders.folderId(id,item.path);if(!folder)fail('PREVIEW_STALE','视频目录已变化，请重新核对',409);
      await c.folders.resolve(id,folder);
      if(c.verification.authority(id,item.id)!==item.authority)fail('PREVIEW_STALE','核对期间视频资料已变化',409);
    }
    for(const item of items)if(c.verification.authority(id,item.id)!==item.authority)fail('PREVIEW_STALE','派发前资料已变化，请重新核对',409);
  }
  clipboard(id,input){
    const ids=idsFor(input);
    return this.journal.start(id,'clipboard',input,async(s,admitted)=>{
      const cap=await this.native.capabilities();if(!cap.clipboard.available)fail(cap.clipboard.code||'CLIPBOARD_UNAVAILABLE',cap.clipboard.reason||'文件剪贴板不可用',409);
      const expectedChangeCount=await admitted;
      const {eligible,skipped}=await this.eligible(id,ids,s);
      const base={requestId:s.requestId,projectId:id,action:'clipboard',requestedCount:ids.length,skipped};
      if(!eligible.length)return {...base,status:'failed',count:0,copied:[],code:'NO_VALID_FILES'};
      await this.validate(id,eligible);
      s.status='running';s.dispatched=true;this.journal.save(s);
      let result;
      try{result=await this.native.copyFiles(eligible.map(v=>v.path),{expectedChangeCount});}
      catch(e){if(e.effectUnknown===false||['CLIPBOARD_CHANGED','CLIPBOARD_UNAVAILABLE','DESKTOP_UNAVAILABLE'].includes(e.code)){s.dispatched=false;this.journal.save(s);}throw e;}
      if(result.ack!=='written'||result.count!==eligible.length)fail('CLIPBOARD_ACK_UNKNOWN','文件剪贴板写入结果未确认，请核对原请求',409);
      return {...base,status:skipped.length?'partial':'completed',count:eligible.length,copied:eligible.map(({id,name,managed,verification})=>({id,name,managed,verification}))};
    },()=>this.native.clipboardVersion());
  }
  revealPreview(id,input){
    const ids=idsFor(input);
    return this.journal.start(id,'reveal-preview',input,async s=>{
      const cap=await this.native.capabilities();if(!cap.revealMany.available)fail(cap.revealMany.code||'REVEAL_UNAVAILABLE',cap.revealMany.reason||'访达不可用',409);
      const {eligible,skipped}=await this.eligible(id,ids,s);
      await this.validate(id,eligible);
      const folders=[...new Set(eligible.map(v=>path.dirname(v.path)))].map((p,i)=>({key:String(i),label:eligible.find(v=>path.dirname(v.path)===p)?.managed?(path.relative(this.catalog.directory,p)||'项目根目录'):'原位置目录'+(i+1),count:eligible.filter(v=>path.dirname(v.path)===p).length}));
      s.preview={token:randomUUID(),expiresAt:Date.now()+120000,eligible,skipped,ids,folders};
      return {requestId:s.requestId,projectId:id,action:'reveal-preview',status:eligible.length?(skipped.length?'partial':'completed'):'failed',previewToken:s.preview.token,expiresAt:s.preview.expiresAt,eligible:eligible.map(({id,name,managed})=>({id,name,managed})),skipped,folderCount:folders.length,folders};
    });
  }
  reveal(id,input){
    const ids=idsFor(input);
    if(!idOK(input.previewToken))fail('PREVIEW_REQUIRED','请先核对访达操作影响',409);
    return this.journal.start(id,'reveal',input,async s=>{
      const rows=this.catalog.db.prepare('SELECT * FROM project_video_operations WHERE project_id=?').all(id);
      const preview=rows.map(r=>JSON.parse(r.data_json)).find(p=>p.namespace==='video-desktop-v1'&&p.action==='reveal-preview'&&p.preview?.token===input.previewToken)?.preview;
      if(!preview||preview.expiresAt<Date.now()||canonical(preview.ids)!==canonical(ids))fail('PREVIEW_STALE','访达预览已过期或选择变化，请重新核对',409);
      const cap=await this.native.capabilities();if(!cap.revealMany.available)fail('REVEAL_UNAVAILABLE','访达当前不可用',409);
      try{await this.validate(id,preview.eligible);}catch(e){if(e.code==='VIDEO_CLOSING')throw e;fail('PREVIEW_STALE','视频、读取授权或目录在核对后变化，请重新核对',409);}
      if(!preview.eligible.length)return {requestId:s.requestId,projectId:id,action:'reveal',status:'failed',requested:[],count:0,folderCount:0,skipped:preview.skipped,code:'NO_VALID_FILES'};
      s.status='running';s.dispatched=true;this.journal.save(s);
      const result=await this.native.revealFiles(preview.eligible.map(v=>v.path));
      if(result.ack!=='dispatched')fail('REVEAL_ACK_UNKNOWN','访达请求结果尚未确认',409);
      return {requestId:s.requestId,projectId:id,action:'reveal',status:preview.skipped.length?'partial':'completed',requested:preview.eligible.map(({id,name})=>({id,name})),count:preview.eligible.length,folderCount:preview.folders.length,ack:'dispatched',skipped:preview.skipped};
    });
  }
}
