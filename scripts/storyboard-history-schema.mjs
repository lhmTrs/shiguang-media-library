import {historySchema,installHistory} from '../server/storyboard/history-schema.mjs';
import Database from 'better-sqlite3';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
// Explicit administrative entry: never invoked by a GET or ordinary existing-library startup.
export function migrateStoryboardHistory(db){return installHistory(db);}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const args=process.argv.slice(2);
 if(args.length===2&&args[0]==='--print'&&['sqlite','mysql'].includes(args[1]))console.log(historySchema(args[1]==='mysql').join(';\n')+';');
 else if(args.length===2&&args[0]==='--apply-sqlite'&&path.isAbsolute(args[1])){
  const db=new Database(args[1],{fileMustExist:true});try{console.log(JSON.stringify(migrateStoryboardHistory(db)));}finally{db.close();}
 }else throw Error('Usage: --print sqlite|mysql OR --apply-sqlite <explicit-existing-absolute-db-path>');
}
