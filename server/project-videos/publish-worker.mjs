// A separate process pins its working directory inode. Relative link operations
// cannot follow a substituted ancestor/symlink in the parent's absolute path.
// This helper accepts only metadata and creates no model, network or DB work.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
const identity=s=>[s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');
try{
  const {directory,stage,stageIdentity,fileName,suffixed}=JSON.parse(process.argv[2]);
  if(typeof stage!=='string'||!path.isAbsolute(stage)||path.basename(stage)!=='original.partial'||!path.basename(path.dirname(stage)).startsWith('shiguang-project-video-import-')||typeof fileName!=='string'||!fileName||path.basename(fileName)!==fileName||/[\\/\x00-\x1f]/.test(fileName))throw Error('Invalid publication metadata');
  const dir=await fs.stat('.');if(!dir.isDirectory()||dir.dev!==directory.dev||dir.ino!==directory.ino)throw Error('项目视频文件夹已变化');
  const st=await fs.lstat(stage);if(!st.isFile()||st.isSymbolicLink()||identity(st)!==stageIdentity)throw Error('待导入视频已变化');
  const ext=path.extname(fileName),stem=fileName.slice(0,fileName.length-ext.length);let number=0,rename=suffixed;
  while(true){const name=rename?stem+'_'+(number++)+ext:fileName;try{if((await fs.readdir('.')).some(n=>n.normalize('NFC').toLowerCase()===name.normalize('NFC').toLowerCase())){const e=Error('目标同名文件已存在，请重新核对冲突');e.code='EEXIST';throw e;}try{await fs.link(stage,name);}catch(e){if(e.code!=='EXDEV')throw e;await fs.copyFile(stage,name,constants.COPYFILE_EXCL);}process.stdout.write(JSON.stringify({fileName:name}));break;}catch(e){if(e.code!=='EEXIST'||!suffixed)throw e;rename=true;}}
}catch(e){process.stderr.write(e.message);process.exitCode=1;}
