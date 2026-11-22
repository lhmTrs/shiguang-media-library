import {syncDir,posixPrivate} from '../fs-platform.mjs';
import fs from '../fs-platform.mjs';
import sync,{constants} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical,fail,hash} from './model.mjs';

export async function privateDirectory(directory){
 await fs.mkdir(directory,{recursive:true,mode:0o700});
 const s=await fs.lstat(directory);
 if(!s.isDirectory()||s.isSymbolicLink()||await fs.realpath(directory)!==directory||!posixPrivate(s))fail('VIDEO_V2_UPGRADE_FILES_INVALID','升级目录必须为当前用户私有真实目录',503);
 return directory;
}
export async function readPrivateJson(file){
 let named;if(process.platform==='win32'){try{named=await fs.lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}if(!named.isFile()||named.isSymbolicLink()||await fs.realpath(file)!==file||await fs.realpath(path.dirname(file))!==path.dirname(file))fail('VIDEO_V2_UPGRADE_FILES_INVALID','升级文件身份无法核验',503);}
 let h;try{h=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(e){if(e.code==='ENOENT')return null;throw e;}
 try{const s=await h.stat();if(!s.isFile()||!posixPrivate(s)||s.size>32*1024*1024)fail('VIDEO_V2_UPGRADE_FILES_INVALID','升级文件身份无法核验',503);const raw=await h.readFile('utf8');if(named){const after=await fs.lstat(file);if(after.isSymbolicLink()||String(named.dev)!==String(s.dev)||String(named.ino)!==String(s.ino)||named.size!==s.size||named.mtimeMs!==s.mtimeMs||String(after.ino)!==String(s.ino)||after.size!==s.size||after.mtimeMs!==s.mtimeMs)fail('VIDEO_V2_UPGRADE_FILES_INVALID','升级文件身份无法核验',503);}return JSON.parse(raw);}finally{await h.close();}
}
export const syncDirectory=syncDir;
export async function writePrivateJson(file,value){
 const temporary=path.join(path.dirname(file),'.'+path.basename(file)+'-'+randomUUID());let h;
 try{h=await fs.open(temporary,'wx',0o600);await h.writeFile(canonical(value));await h.sync();await h.close();h=null;await fs.rename(temporary,file);await syncDirectory(path.dirname(file));}
 finally{await h?.close();await fs.unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
export function validateUpgradePolicy(value,instanceId){
 if(!value||canonical(Object.keys(value).sort())!==canonical(['format','schemaVersion','instanceId','policyId','mode','reason','createdAt'].sort())||value.format!=='shiguang-video-v2-upgrade-policy'||value.schemaVersion!==1||typeof value.instanceId!=='string'||typeof value.policyId!=='string'||!['automatic','defer'].includes(value.mode)||typeof value.reason!=='string'||!value.reason.trim()||value.reason.length>2000||!Number.isSafeInteger(value.createdAt))fail('VIDEO_V2_UPGRADE_POLICY_INVALID','升级策略格式无效，未执行迁移',503);
 if(value.instanceId!==instanceId)fail('VIDEO_V2_UPGRADE_INSTANCE_MISMATCH','升级策略与当前库实例不一致，未执行迁移',503);
 return value;
}
// A complete owner record is linked atomically. Dead owners can be reclaimed;
// a live/reused PID or unverifiable record never authorizes stealing the lock.
export async function acquireUpgradeFileLock(directory,instanceId){
 const file=path.join(directory,'startup-'+hash(instanceId)+'.lock'),temporary=path.join(directory,'.owner-'+randomUUID()),owner={instanceId,pid:process.pid,token:randomUUID()};
 let h=await fs.open(temporary,'wx',0o600);try{await h.writeFile(canonical(owner));await h.sync();}finally{await h.close();}
 try{
  for(let attempt=0;attempt<2;attempt++){
   try{await fs.link(temporary,file);await syncDirectory(directory);return async()=>{const current=await readPrivateJson(file);if(current?.token!==owner.token)fail('VIDEO_V2_UPGRADE_LOCK_UNKNOWN','升级锁归属变化',503);await fs.unlink(file);await syncDirectory(directory);};}
   catch(e){if(e.code!=='EEXIST')throw e;const old=await readPrivateJson(file);if(!old||old.instanceId!==instanceId||!Number.isSafeInteger(old.pid)||old.pid<1||typeof old.token!=='string')fail('VIDEO_V2_UPGRADE_LOCK_UNKNOWN','升级锁无法核验，未执行迁移',503);
    let dead=false;try{process.kill(old.pid,0);}catch(error){if(error.code==='ESRCH')dead=true;}
    if(!dead)return null;
    const before=sync.lstatSync(file),current=JSON.parse(sync.readFileSync(file,'utf8')),after=sync.lstatSync(file);
    if(before.dev!==after.dev||before.ino!==after.ino||current.token!==old.token)fail('VIDEO_V2_UPGRADE_LOCK_UNKNOWN','升级锁核对期间变化',503);
    sync.unlinkSync(file);
   }
  }
  return null;
 }finally{await fs.unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
