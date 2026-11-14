import fs from 'node:fs/promises';
import path from 'node:path';
import {error} from './files.mjs';
import {validName} from './media-catalog.mjs';
import {folderName} from '../project-videos/folders.mjs';

const key = name => name.normalize('NFC').toLowerCase();

export function checkChoice(file, {destination:d,nameMode}={}) {
  const kind=file.mediaKind||'video';
  if(!d||!(kind==='audio'?['music','sfx'].includes(d.kind):kind===d.kind)||!['library','project'].includes(d.scope))
    throw error('INTAKE_TYPE_MISMATCH','文件类型与目标不一致，未开始任何收纳',400);
  if(nameMode!==undefined&&nameMode!=='keep'&&nameMode!=='standard')
    throw error('INTAKE_INVALID_INPUT','收纳命名模式无效',400);
  if(d.fileName!==undefined&&(typeof d.fileName!=='string'||path.extname(d.fileName).toLowerCase()!==path.extname(file.name).toLowerCase()))
    throw error('INTAKE_INVALID_INPUT','只可修改副本名称，请保留原扩展名',400);
  if(d.fileName!==undefined)validName(d.fileName);
  if(d.newFolder!==undefined){
    if(d.kind!=='video'||d.scope!=='project'||!d.newFolder||Object.keys(d.newFolder).join(',')!=='name')
      throw error('INTAKE_INVALID_INPUT','仅项目视频可在选定目录下新建一个文件夹',400);
    folderName(d.newFolder.name);
  }
}

export const wantsStandard = (d, mode) => mode==='standard' && d.scope==='project' && d.fileName===undefined;

const videoSequence = name => Number(path.parse(name).name.match(/_([0-9]{2,4})$/)?.[1]??0);
function nameSegment(value) {
  if(!value)throw error('INTAKE_NAME_MANUAL_REQUIRED','项目或目录名称为空，请手动命名',422);
  return value.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]|^[. ]+|[. ]+$/g,part=>'-'.repeat(part.length));
}
function videoName(project,series,folder) {
  const parts=[];
  if(series){
    parts.push({role:'series',text:nameSegment(series.name)});
    if(series.seasonNo!==null)parts.push({role:'season',text:'S'+String(series.seasonNo).padStart(2,'0')});
    parts.push({role:'episode',text:(series.seasonNo===null?'EP':'E')+String(series.episodeNo).padStart(2,'0')});
  }else parts.push({role:'project',text:nameSegment(project.name)});
  const title=parts.map(p=>p.text).join('');
  const folders=folder?.relativePath?.split('/').map(text=>({role:'folder',text:nameSegment(text)}))??[];
  return {base:[title,...folders.map(p=>p.text)].join('_'),parts:[...parts,...folders]};
}
function standardVideoFileName(name){
  try{return validName(name);}
  catch{throw error('INTAKE_NAME_MANUAL_REQUIRED','自动名称过长或无效，请手动命名',422);}
}

async function directoryNames(dir, verify) {
  await verify?.();
  const stat=await fs.lstat(dir).catch(e=>e.code==='ENOENT'?null:Promise.reject(e));
  if(!stat){await verify?.();return [];}
  if(!stat.isDirectory()||stat.isSymbolicLink()||await fs.realpath(dir)!==dir)
    throw error('TARGET_CHANGED','不能从已移动或替换的目录分配名称');
  const entries=await fs.readdir(dir,{withFileTypes:true});
  const after=await fs.lstat(dir);
  if(after.dev!==stat.dev||after.ino!==stat.ino||await fs.realpath(dir)!==dir)
    throw error('TARGET_CHANGED','核对名称期间目录已变化');
  await verify?.();
  return entries.filter(entry=>entry.isFile()).map(entry=>entry.name);
}

// One physical directory scan per request. Pending receipts cover the time
// between accepting a task and publishing its file. Non-numbered names in the
// same confirmation are known before numbers are allocated.
export class IntakeNames {
  constructor(pending) {this.reserved=new Map();this.scans=new Map();this.maximum=new Map();this.videoMaximum=new Map();
    for(const [directory,name] of pending)this.reserve(directory,name);
  }
  reserve(directory,name) {
    if(!directory||!name)return;
    if(!this.reserved.has(directory))this.reserved.set(directory,new Set());
    this.reserved.get(directory).add(name);
    if(this.videoMaximum.has(directory))
      this.videoMaximum.set(directory,Math.max(this.videoMaximum.get(directory),videoSequence(name)));
    for(const [prefix,highest] of this.maximum.get(directory)??[]) {
      const n=this.number(prefix,name);
      if(n>highest)this.maximum.get(directory).set(prefix,n);
    }
  }
  number(prefix,entry) {
    const basename=key(path.parse(entry).name);
    if(!basename.startsWith(prefix))return 0;
    const suffix=basename.slice(prefix.length);
    return /^\d{3,}$/.test(suffix)?Number(suffix):0;
  }
  async plan(file,{destination:d,nameMode,project,series,folder,assetName,directory,verify}) {
    if(!wantsStandard(d,nameMode))return {proposedFileName:d.fileName??file.name,proposedNumber:null};
    const ext=path.extname(file.name);
    if(d.kind==='photo'&&!d.assetKind) {
      const proposal=d.imageProposal??d;
      return {proposedFileName:validName(proposal.characterName+'_'+proposal.lookName+ext),proposedNumber:null};
    }
    const video=d.kind==='video'?videoName(project,series,folder):null;
    const base=video?.base??assetName;
    if(video)standardVideoFileName(base+'_001'+ext);
    else validName(base+'_001'+ext);
    const prefix=key(base+'_');
    if(!this.scans.has(directory))this.scans.set(directory,directoryNames(directory,verify));
    const entries=await this.scans.get(directory);
    if(video){
      if(!this.videoMaximum.has(directory)){
        let max=0;
        for(const names of [entries,this.reserved.get(directory)??[]])
          for(const name of names)max=Math.max(max,videoSequence(name));
        this.videoMaximum.set(directory,max);
      }
      const n=this.videoMaximum.get(directory)+1;
      if(n>9999)throw error('INTAKE_NAME_NUMBER_LIMIT','此目录的编号已到 9999，请手动命名',422);
      const number=String(n).padStart(3,'0');
      const name=standardVideoFileName(base+'_'+number+ext);
      this.reserve(directory,name);
      return {proposedFileName:name,proposedNumber:n,nameParts:[...video.parts,{role:'number',text:number},{role:'ext',text:ext}]};
    }
    if(!this.maximum.has(directory))this.maximum.set(directory,new Map());
    const byPrefix=this.maximum.get(directory);
    if(!byPrefix.has(prefix)){
      let highest=0;
      for(const entriesOfSource of [entries,this.reserved.get(directory)??[]])
        for(const entry of entriesOfSource)highest=Math.max(highest,this.number(prefix,entry));
      byPrefix.set(prefix,highest);
    }
    const n=byPrefix.get(prefix)+1;
    if(!Number.isSafeInteger(n))throw error('INTAKE_NAME_NUMBER_LIMIT','现有文件编号超出可分配范围，请手动命名',422);
    const name=validName(base+'_'+String(n).padStart(3,'0')+ext);
    this.reserve(directory,name);
    return {proposedFileName:name,proposedNumber:n};
  }
}
