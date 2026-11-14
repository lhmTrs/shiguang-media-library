import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {privateDirectory,uuid,error} from './files.mjs';

const kinds=new Set(['photo','video','music','sfx']);
const themes=new Set(['forest','dark','midnight','sepia','graphite','ocean']);
const maxBytes=128*1024;
export const defaultRoutingPreferences=()=>({
  lastProjectId:{photo:null,video:null},lastVideoFolderByProject:{},
  lastLibraryDirectory:{photo:'',video:'',music:'',sfx:''},lastAudioKind:null,mode:'copy',standardNames:false,revealWhenDone:false,
});
const validFolder=id=>uuid(id)||id==='root';
const isAudio=kind=>kind==='music'||kind==='sfx';
// Convenience preferences contain no authority, source paths or IDs
// of people. Every restored destination is checked again before confirmation.
export function preferenceTarget(value) {
  if(!value||!kinds.has(value.kind)||!['library','project'].includes(value.scope))return null;
  if(value.scope==='project')return ['photo','video'].includes(value.kind)&&uuid(value.projectId)
    ? {kind:value.kind,scope:'project',projectId:value.projectId,...(value.kind==='video'?{folderId:uuid(value.folderId)?value.folderId:'root'}:{})}:null;
  const directory=value.directory??'';
  if(typeof directory!=='string'||directory.length>500||directory.split('/').length>2||(directory&&directory.split('/').some(p=>!p||p==='.'||p==='..'))||/[\\\x00-\x1f]/.test(directory)||directory.startsWith('/'))return null;
  return {kind:value.kind,scope:'library',directory};
}
function recordTarget(r,t) {
  if(t.scope==='project') {
    r.lastProjectId[t.kind]=t.projectId;
    if(t.kind==='video') {
      // Keep bounded recent per-project history; remove/reinsert to update order.
      delete r.lastVideoFolderByProject[t.projectId];
      r.lastVideoFolderByProject[t.projectId]=t.folderId;
      const ids=Object.keys(r.lastVideoFolderByProject);
      for(const id of ids.slice(0,Math.max(0,ids.length-1000)))delete r.lastVideoFolderByProject[id];
    }
  } else r.lastLibraryDirectory[t.kind]=t.directory;
  if(isAudio(t.kind))r.lastAudioKind=t.kind;
}
function loadRouting(raw) {
  const r=defaultRoutingPreferences();
  for(const kind of ['photo','video'])if(uuid(raw?.lastProjectId?.[kind]))r.lastProjectId[kind]=raw.lastProjectId[kind];
  for(const [id,folder] of Object.entries(raw?.lastVideoFolderByProject??{}).slice(-1000))
    if(uuid(id)&&validFolder(folder))r.lastVideoFolderByProject[id]=folder;
  for(const kind of kinds){
    const t=preferenceTarget({kind,scope:'library',directory:raw?.lastLibraryDirectory?.[kind]});
    if(t)r.lastLibraryDirectory[kind]=t.directory;
  }
  if(isAudio(raw?.lastAudioKind))r.lastAudioKind=raw.lastAudioKind;
  if(raw?.mode==='move')r.mode='move';
  r.standardNames=raw?.standardNames===true;
  r.revealWhenDone=raw?.revealWhenDone===true;
  return r;
}
export class IntakePreferences {
  constructor({dataDir,libraryId}) {
    this.directory=path.join(dataDir,'file-intake');this.file=path.join(this.directory,'preferences.json');
    this.libraryId=libraryId;this.values={};this.routing=defaultRoutingPreferences();this.themeId=null;this.work=Promise.resolve();
  }
  async init(){
    try{await privateDirectory(this.directory);this.identity=await fs.lstat(this.directory);}catch{this.warning='上次目标偏好未能读取，请重新选择；文件任务不受影响';return this;}
    let h;try{
      h=await fs.open(this.file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const st=await h.stat();
      if(!st.isFile()||st.size>maxBytes||(process.getuid&&st.uid!==process.getuid())||(process.platform!=='win32'&&(st.mode&0o077)))throw Error('invalid preferences');
      const v=JSON.parse(await h.readFile('utf8'));
      if([1,2].includes(v.version)&&v.libraryId===this.libraryId) {
        for(const [kind,t] of Object.entries(v.targets||{})){
          const safe=preferenceTarget(t);
          if(safe&&safe.kind===kind){this.values[kind]=safe;if(v.version===1)recordTarget(this.routing,safe);}
        }
        if(v.version===2){this.routing=loadRouting(v.routingPreferences);if(themes.has(v.themeId))this.themeId=v.themeId;}
      }
    }catch(e){if(e.code!=='ENOENT')this.warning='上次目标偏好未能读取，请重新选择；文件任务不受影响';}finally{await h?.close();}return this;
  }
  snapshot(projects=[],hasFolder=()=>true){
    const ids=new Set(projects.filter(p=>!p.archived).map(p=>p.id)), r=structuredClone(this.routing);
    const safeFolder=(id,folder)=>folder==='root'||hasFolder(id,folder)?folder:'root';
    for(const kind of ['photo','video'])if(!ids.has(r.lastProjectId[kind]))r.lastProjectId[kind]=null;
    for(const [id,folder] of Object.entries(r.lastVideoFolderByProject))
      if(!ids.has(id))delete r.lastVideoFolderByProject[id];else r.lastVideoFolderByProject[id]=safeFolder(id,folder);
    const targets=Object.fromEntries(Object.entries(this.values).filter(([,t])=>t.scope==='library'||ids.has(t.projectId)).map(([kind,t])=>
      [kind,t.scope==='project'&&kind==='video'?{...t,folderId:safeFolder(t.projectId,t.folderId)}:{...t}]));
    return {targets,routingPreferences:r,...(this.warning?{warning:this.warning}:{})};
  }
  update(change) {
    const work=this.work.then(async()=>{
      const next={targets:{...this.values},routingPreferences:structuredClone(this.routing),themeId:this.themeId};
      if(change(next)===false)return {themeId:this.themeId};
      const st=await fs.lstat(this.directory);
      if(!this.identity||st.isSymbolicLink()||st.dev!==this.identity.dev||st.ino!==this.identity.ino||await fs.realpath(this.directory)!==this.directory)
        throw error('INTAKE_TARGET_CHANGED','偏好保存目录已变化');
      const temp=path.join(this.directory,'.preferences-'+randomUUID());let h;
      try{
        h=await fs.open(temp,'wx',0o600);await h.writeFile(JSON.stringify({version:2,libraryId:this.libraryId,...next}));await h.sync();
        await h.close();h=null;await fs.rename(temp,this.file);
        const dir=await fs.open(this.directory,'r');try{await dir.sync();}finally{await dir.close();}
        this.values=next.targets;this.routing=next.routingPreferences;this.themeId=next.themeId;delete this.warning;
        return {themeId:this.themeId};
      }finally{await h?.close();await fs.unlink(temp).catch(()=>{});}
    });this.work=work.catch(()=>{});return work;
  }
  remember(targets,{mode,standardNames,revealWhenDone}={}){
    const safe=targets.map(preferenceTarget).filter(Boolean);if(!safe.length)return Promise.resolve();
    return this.update(next=>{
      for(const t of safe){next.targets[t.kind]=t;recordTarget(next.routingPreferences,t);}
      if(mode==='copy'||mode==='move')next.routingPreferences.mode=mode;
      if(typeof standardNames==='boolean')next.routingPreferences.standardNames=standardNames;
      if(safe.length===1&&safe[0].kind==='video'&&typeof revealWhenDone==='boolean')
        next.routingPreferences.revealWhenDone=revealWhenDone;
    });
  }
  setTheme({themeId,onlyIfUnset}={}){
    if(!themes.has(themeId)||onlyIfUnset!==undefined&&typeof onlyIfUnset!=='boolean')
      throw error('INTAKE_INVALID_INPUT','主题无效',400);
    return this.update(next=>{
      if(next.themeId===themeId||onlyIfUnset&&next.themeId!==null)return false;
      next.themeId=themeId;
    });
  }
  async close(){await this.work;}
}
