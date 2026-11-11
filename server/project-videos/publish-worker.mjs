// A separate process pins its working directory inode. Relative link operations
// cannot follow a substituted ancestor/symlink in the parent's absolute path.
// This helper accepts only metadata and creates no model, network or DB work.
import fs from 'node:fs/promises';
import {constants,lstatSync,unlinkSync} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';

const identity=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
const validName=name=>typeof name==='string'&&!!name&&name!=='.'&&name!=='..'&&path.basename(name)===name&&!/[\\/\x00-\x1f]/.test(name);
const regular=s=>s?.isFile()&&!s.isSymbolicLink();
function discardFile(name,proof){
  const current=lstatSync(name,{throwIfNoEntry:false});
  if(!current)return;
  if(!regular(current)||identity(current)!==proof)throw Error('副本身份变化，未移除');
  unlinkSync(name);
}
async function copyWithProof(stage,stageIdentity,name){
  const source=await fs.open(stage,constants.O_RDONLY|constants.O_NOFOLLOW);
  let output;
  try{
    if(identity(await source.stat())!==stageIdentity)throw Error('待导入视频已变化');
    output=await fs.open(name,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    await pipeline(source.createReadStream({autoClose:false}),output.createWriteStream({autoClose:false}));
    await output.sync();
    return identity(await output.stat());
  }catch(e){
    if(output){
      try{discardFile(name,identity(await output.stat()));}
      catch{throw Error('视频副本写入失败，状态待核对，已保留现场');}
    }
    throw e;
  }finally{
    try{await output?.close();}finally{await source.close();}
  }
}
async function publish(name,{stage,stageIdentity,st,copyOnly,reportIdentity}){
  if(copyOnly===true){await fs.copyFile(stage,name,constants.COPYFILE_EXCL);return;}
  try{await fs.link(stage,name);}catch(e){
    if(e.code!=='EXDEV')throw e;
    if(reportIdentity)return copyWithProof(stage,stageIdentity,name);
    await fs.copyFile(stage,name,constants.COPYFILE_EXCL);
    return;
  }
  if(reportIdentity){
    const linked=lstatSync(name);
    if(!regular(linked)||linked.dev!==st.dev||linked.ino!==st.ino||linked.size!==st.size||linked.mtimeMs!==st.mtimeMs)throw Error('已发布副本身份变化，状态待核对，已保留现场');
    return identity(linked);
  }
}
try{
  const {directory,stage,stageIdentity,fileName,suffixed,copyOnly,reportIdentity,discard}=JSON.parse(process.argv[2]);
  const dir=await fs.stat('.');
  if(!dir.isDirectory()||dir.dev!==directory.dev||dir.ino!==directory.ino)throw Error('项目视频文件夹已变化');
  if(discard){
    if(!validName(discard.fileName)||typeof discard.identity!=='string')throw Error('Invalid rollback metadata');
    discardFile(discard.fileName,discard.identity);
    process.stdout.write(JSON.stringify({discarded:true}));
  }else{
    if(typeof stage!=='string'||!path.isAbsolute(stage)||path.basename(stage)!=='original.partial'||!path.basename(path.dirname(stage)).startsWith('shiguang-project-video-import-')||!validName(fileName))throw Error('Invalid publication metadata');
    const st=await fs.lstat(stage);
    if(!regular(st)||identity(st)!==stageIdentity)throw Error('待导入视频已变化');
    const ext=path.extname(fileName),stem=fileName.slice(0,fileName.length-ext.length);
    let number=0,rename=suffixed;
    while(true){
      const name=rename?stem+'_'+(number++)+ext:fileName;
      try{
        if((await fs.readdir('.')).some(n=>n.normalize('NFC').toLowerCase()===name.normalize('NFC').toLowerCase())){
          const e=Error('目标同名文件已存在，请重新核对冲突');e.code='EEXIST';throw e;
        }
        const proof=await publish(name,{stage,stageIdentity,st,copyOnly,reportIdentity});
        process.stdout.write(JSON.stringify({fileName:name,...(proof?{identity:proof}:{})}));
        break;
      }catch(e){if(e.code!=='EEXIST'||!suffixed)throw e;rename=true;}
    }
  }
}catch(e){process.stderr.write(e.message);process.exitCode=1;}
