import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {within,rootIdentity} from '../fs-identity.mjs';
import {fault} from '../prompt-templates/model.mjs';
import {sha256,privateDirectory,validId} from './media.mjs';

export function projectFolderName(project){
  if(!project)return'未选择项目';
  if(!validId(project.id)||typeof project.name!=='string'||!project.name.trim()||project.name.length>120)throw fault('图片所属项目无效');
  const clean=project.name.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/^[. ]+|[. ]+$/g,'');let stem='';
  for(const char of clean){if(Buffer.byteLength(stem+char)>96)break;stem+=char;}
  return(stem.replace(/[. ]+$/g,'')||'项目')+'--'+project.id.toLowerCase();
}

// A managed copy is separate from the immutable chat attachment/backup file.
export class CodexPictures {
  constructor(lib,{directory,onRootAdded=()=>{}}){this.lib=lib;this.directory=path.resolve(directory);this.onRootAdded=onRootAdded;this.queue=Promise.resolve();}
  serial(fn){const work=this.queue.then(fn);this.queue=work.catch(()=>{});return work;}
  writable(){if(process.env.MEDIA_READONLY_FILES==='1')throw fault('素材目录为只读，原图已保留在对话中，未自动写入 picture',403);if(this.lib.migrating)throw fault('素材库正在迁移，原图已保留，稍后再扫描 picture',423);}
  async prepare(){
    this.writable();const parent=path.dirname(this.directory),base=await fs.realpath(path.dirname(parent)),canonical=path.join(base,path.basename(parent),path.basename(this.directory));
    if(this.canonicalDirectory&&this.canonicalDirectory!==canonical)throw fault('个人素材目录的上级路径已变化',409);
    this.canonicalDirectory=canonical;this.directory=canonical;const roots=this.lib.allRoots();
    if(roots.some(r=>r.retired&&(within(r.path,this.directory)||within(this.directory,r.path))))throw fault('picture 所属目录已注销，请先在素材目录中恢复管理',409);
    const canonicalParent=path.dirname(this.directory);
    await privateDirectory(canonicalParent);if(await fs.realpath(canonicalParent)!==canonicalParent)throw fault('personal_item 不能使用符号链接',409);
    await privateDirectory(this.directory);if(await fs.realpath(this.directory)!==this.directory)throw fault('picture 不能使用符号链接',409);
    let root=roots.find(r=>!r.retired&&within(r.path,this.directory));
    if(!root){root=await this.lib.addRoot(this.directory,'photo');await this.onRootAdded();}
    const identity=await rootIdentity(root),directory=await fs.lstat(this.directory);
    return{root,identity,directory};
  }
  async current(state){this.writable();const root=this.lib.roots().find(r=>r.id===state.root.id&&r.path===state.root.path);if(!root||await rootIdentity(root)!==state.identity||await fs.realpath(this.directory)!==this.directory)throw fault('图片目标目录或登记状态已变化',409);const st=await fs.lstat(this.directory);if(st.dev!==state.directory.dev||st.ino!==state.directory.ino||st.isSymbolicLink())throw fault('picture 目录已变化',409);if(state.target){const target=await fs.lstat(state.target);if(target.isSymbolicLink()||target.dev!==state.targetIdentity.dev||target.ino!==state.targetIdentity.ino||await fs.realpath(state.target)!==state.target)throw fault('项目图片文件夹已变化',409);}}
  initialize(){return this.serial(async()=>{const state=await this.prepare();await this.current(state);return{directory:this.directory,rootId:state.root.id};});}
  publish(row,bytes,project){const scope=project?{id:project.id,name:project.name}:null;return this.serial(async()=>{
    if(bytes.length!==row.bytes||sha256(bytes)!==row.sha256)throw fault('原图校验失败，未写入 picture');
    const proposed=projectFolderName(scope),state=await this.prepare();await this.current(state);
    const existing=scope?(await fs.readdir(this.directory,{withFileTypes:true})).filter(e=>e.name.endsWith('--'+scope.id.toLowerCase())):[];
    if(existing.length>1)throw fault('同一项目有多个图片文件夹，请核对后再保存',409);
    const folder=existing[0]?.name||proposed,target=path.join(this.directory,folder);await privateDirectory(target);if(await fs.realpath(target)!==target)throw fault('项目图片文件夹不能使用符号链接',409);
    Object.assign(state,{target,targetIdentity:await fs.lstat(target)});
    const fileName='Codex-'+row.file_name,file=path.join(target,fileName);await this.current(state);
    const temporary=path.join(target,'.codex-'+randomUUID()+'.partial');
    try{
      await fs.writeFile(temporary,bytes,{flag:'wx',mode:0o600});await this.current(state);
      try{await fs.link(temporary,file);}catch(e){if(e.code!=='EEXIST')throw e;const st=await fs.lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.size!==row.bytes||sha256(await fs.readFile(file))!==row.sha256)throw fault('picture 内同名文件已存在且内容不同，未覆盖',409);}
    }finally{await fs.unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
    await this.current(state);
    const active=()=>[...this.lib.jobs.values()].find(j=>j.rootId===state.root.id&&j.status==='running');
    const deadline=Date.now()+30000;while(active()){if(Date.now()>=deadline)throw fault('原图已保存到 picture，目录扫描尚未结束');await new Promise(r=>setTimeout(r,20));await this.current(state);}
    const job=this.lib.scan(state.root.id);while(job.status==='running'){if(Date.now()>=deadline)throw fault('原图已保存到 picture，素材索引仍在处理中');await new Promise(r=>setTimeout(r,20));}
    if(job.status!=='done')throw fault('原图已保存到 picture，但素材索引未完成，请刷新该目录');
    await this.current(state);const asset=this.lib.db.prepare('SELECT id FROM assets WHERE path=? AND root_id=? AND trashed=0').get(file,state.root.id);
    if(!asset)throw fault('原图已保存到 picture，但尚未找到素材记录');
    return{status:'ready',rootId:state.root.id,assetId:asset.id,fileName,relativePath:path.join(folder,fileName),projectId:scope?.id??null,projectName:scope?.name??'未选择项目'};
  });}
}
