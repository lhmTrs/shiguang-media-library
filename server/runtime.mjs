import {createRequire} from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function dataDirectory(project, env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.MEDIA_DATA_DIR) return path.resolve(env.MEDIA_DATA_DIR);
  if (platform==='win32') {
    const portable=path.join(project,'data'),local=path.join(env.LOCALAPPDATA||path.join(home,'AppData','Local'),'ShiguangMedia');
    const old=windowsLibraryState(portable),current=windowsLibraryState(local);
    if(path.resolve(portable)===path.resolve(local))return local;
    if(old==='unknown'||current==='unknown')throw Object.assign(Error('库目录尚未核清，请用 MEDIA_DATA_DIR 明确选择原库'),{code:'DATA_DIRECTORY_UNCONFIRMED'});
    if(old==='valid'&&current==='valid')throw Object.assign(Error('发现两份已有素材库，请用 MEDIA_DATA_DIR 明确选择；未移动或合并数据'),{code:'DATA_DIRECTORY_CONFLICT'});
    return old==='valid'?portable:local;
  }
  if (env.MEDIA_PORTABLE === "1") return path.join(project, "data");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "拾光素材库");
  if (platform === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "ShiguangMedia");
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "shiguang-media");
}

// Passive local candidates: readonly SQLite schema only, no network, mkdir, repair or move.
function windowsLibraryState(directory) {
 try{const st=fs.lstatSync(directory);if(!st.isDirectory()||st.isSymbolicLink())return 'unknown';}catch(e){if(e.code==='ENOENT')return 'absent';throw e;}
 let known=false;
 for(const name of ['library.sqlite','mysql-connection.json']){
  const file=path.join(directory,name);let fd;
  try{
   const named=fs.lstatSync(file);if(!named.isFile()||named.isSymbolicLink()||named.nlink!==1)return 'unknown';
   if(name.endsWith('.sqlite')){fd=fs.openSync(file,'r');const bytes=Buffer.alloc(16);if(fs.readSync(fd,bytes,0,16,0)!==16||bytes.toString()!=='SQLite format 3\0')return 'unknown';
    let db;try{const Database=createRequire(import.meta.url)('better-sqlite3');db=new Database(file,{readonly:true,fileMustExist:true,timeout:1000});
      for(const [table,required]of [['roots',['id','path']],['assets',['id','root_id','path']]]){const columns=new Set(db.prepare('PRAGMA table_info('+table+')').all().map(c=>c.name));if(required.some(c=>!columns.has(c)))return 'unknown';}
    }finally{db?.close();}}
   else {if(named.size>16384)return 'unknown';const config=JSON.parse(fs.readFileSync(file,'utf8'));if(!['127.0.0.1','localhost','::1'].includes(config.host)||!Number.isInteger(config.port)||typeof config.database!=='string'||typeof config.user!=='string')return 'unknown';}
   known=true;
  }catch(e){if(e.code!=='ENOENT')return 'unknown';}finally{if(fd!==undefined)fs.closeSync(fd);}
 }
 return known?'valid':'absent';
}
