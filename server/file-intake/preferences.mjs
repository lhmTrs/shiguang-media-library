import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {privateDirectory,uuid,error} from './files.mjs';

const kinds=new Set(['photo','video','music','sfx']);
// Convenience preferences contain no authority, source paths, removal mode or IDs
// of people. Every restored destination is checked again before confirmation.
export function preferenceTarget(value) {
  if(!value||!kinds.has(value.kind)||!['library','project'].includes(value.scope))return null;
  if(value.scope==='project')return ['photo','video'].includes(value.kind)&&uuid(value.projectId)
    ? {kind:value.kind,scope:'project',projectId:value.projectId,...(value.kind==='video'?{folderId:uuid(value.folderId)?value.folderId:'root'}:{})}:null;
  const directory=value.directory??'';
  if(typeof directory!=='string'||directory.length>500||directory.split('/').length>2||(directory&&directory.split('/').some(p=>!p||p==='.'||p==='..'))||/[\\\x00-\x1f]/.test(directory)||directory.startsWith('/'))return null;
  return {kind:value.kind,scope:'library',directory};
}
export class IntakePreferences {
  constructor({dataDir,libraryId}){this.directory=path.join(dataDir,'file-intake');this.file=path.join(this.directory,'preferences.json');this.libraryId=libraryId;this.values={};this.work=Promise.resolve();}
  async init(){
    try{await privateDirectory(this.directory);this.identity=await fs.lstat(this.directory);}catch{this.warning='上次目标偏好未能读取，请重新选择；文件任务不受影响';return this;}
    let h;try{h=await fs.open(this.file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const st=await h.stat();
      if(!st.isFile()||st.size>16384||(process.getuid&&st.uid!==process.getuid())||(process.platform!=='win32'&&(st.mode&0o077)))throw Error('invalid preferences');
      const v=JSON.parse(await h.readFile('utf8'));if(v.version===1&&v.libraryId===this.libraryId)for(const [kind,t] of Object.entries(v.targets||{})){const safe=preferenceTarget(t);if(safe&&safe.kind===kind)this.values[kind]=safe;}
    }catch(e){if(e.code!=='ENOENT')this.warning='上次目标偏好未能读取，请重新选择；文件任务不受影响';}finally{await h?.close();}return this;
  }
  snapshot(projects=[]){const ids=new Set(projects.filter(p=>!p.archived).map(p=>p.id));return {targets:Object.fromEntries(Object.entries(this.values).filter(([,t])=>t.scope==='library'||ids.has(t.projectId))),...(this.warning?{warning:this.warning}:{})};}
  remember(targets){const safe=targets.map(preferenceTarget).filter(Boolean);if(!safe.length)return Promise.resolve();
    const work=this.work.then(async()=>{const st=await fs.lstat(this.directory);if(st.isSymbolicLink()||st.dev!==this.identity.dev||st.ino!==this.identity.ino||await fs.realpath(this.directory)!==this.directory)throw error('INTAKE_TARGET_CHANGED','偏好保存目录已变化');
      const next={...this.values};for(const t of safe)next[t.kind]=t;
      const temp=path.join(this.directory,'.preferences-'+randomUUID());let h;
      try{h=await fs.open(temp,'wx',0o600);await h.writeFile(JSON.stringify({version:1,libraryId:this.libraryId,targets:next}));await h.sync();await h.close();h=null;await fs.rename(temp,this.file);const dir=await fs.open(this.directory,'r');try{await dir.sync();}finally{await dir.close();}this.values=next;delete this.warning;}
      finally{await h?.close();await fs.unlink(temp).catch(()=>{});}
    });this.work=work.catch(()=>{});return work;
  }
  async close(){await this.work;}
}
