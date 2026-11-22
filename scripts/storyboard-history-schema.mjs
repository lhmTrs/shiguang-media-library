import {syncDir,posixPrivate} from '../server/fs-platform.mjs';
import {historySchema,installHistory} from '../server/storyboard/history-schema.mjs';
import Database from 'better-sqlite3';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import fs from '../server/fs-platform.mjs';
import {randomUUID} from 'node:crypto';
// Explicit administrative entry: never invoked by a GET or ordinary existing-library startup.
export function migrateStoryboardHistory(db){return installHistory(db);}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const args=process.argv.slice(2);
 if(args.length===2&&args[0]==='--print'&&['sqlite','mysql'].includes(args[1]))console.log(historySchema(args[1]==='mysql').join(';\n')+';');
 else if(args.length===2&&args[0]==='--apply-sqlite'&&path.isAbsolute(args[1])){
  if(await fs.realpath(args[1])!==args[1]||await fs.realpath(path.dirname(args[1]))!==path.dirname(args[1]))throw Error('Explicit database path must not use symbolic links');
  const folder=path.join(path.dirname(args[1]),'storyboard-history-backups');try{await fs.mkdir(folder,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
  const stat=await fs.lstat(folder);if(!stat.isDirectory()||stat.isSymbolicLink()||!posixPrivate(stat))throw Error('Private backup directory is unsafe');
  const backup=path.join(folder,'before-history-'+Date.now()+'-'+randomUUID()+'.sqlite');const file=await fs.open(backup,'wx',0o600);await file.close();
  const db=new Database(args[1],{fileMustExist:true});try{
   await db.backup(backup);const copy=new Database(backup,{readonly:true,fileMustExist:true});try{if(copy.pragma('quick_check',{simple:true})!=='ok')throw Error('Backup validation failed; no DDL applied');}finally{copy.close();}
   const handle=await fs.open(backup,'r');try{await handle.sync();}finally{await handle.close();}await syncDir(folder);
   const result=db.transaction(()=>migrateStoryboardHistory(db)).immediate();console.log(JSON.stringify({...result,backup}));
  }finally{db.close();}
 }else throw Error('Usage: --print sqlite|mysql OR --apply-sqlite <explicit-existing-absolute-db-path>');
}
