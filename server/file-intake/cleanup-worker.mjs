// Pin the freshly owned temporary directory as cwd. No recursive deletion, no
// path supplied by HTTP, no old/unknown receipt sweep and no asynchronous gap
// between the final identity checks and unlink of this one private stage.
import fs from 'node:fs';
const stamp=s=>({dev:String(s.dev),ino:String(s.ino),size:s.size,mtimeMs:s.mtimeMs,ctimeMs:s.ctimeMs});
try {
  const {directory,stage}=JSON.parse(process.argv[2]);
  const dir=fs.lstatSync('.');
  if(!dir.isDirectory()||String(dir.dev)!==directory.dev||String(dir.ino)!==directory.ino||
     process.getuid&&dir.uid!==process.getuid()||(dir.mode&0o077))throw Error('临时目录身份或权限已变化');
  const current=fs.lstatSync('original.partial');
  if(!current.isFile()||current.isSymbolicLink()||Object.keys(stage).length!==5||
     Object.entries(stamp(current)).some(([k,v])=>stage[k]!==v))throw Error('临时副本身份已变化');
  fs.unlinkSync('original.partial');
  process.stdout.write(JSON.stringify({stageRemoved:true}));
}catch(e){process.stderr.write(e.message);process.exitCode=1;}
