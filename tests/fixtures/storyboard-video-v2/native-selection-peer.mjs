// Spawned only by the owned native scene; all supplied files/databases are synthetic.
import {parentPort,workerData} from 'node:worker_threads';
import {once} from 'node:events';
import {Library} from '../../../server/library.mjs';
import {MysqlDatabase} from '../../../server/mysql-db.mjs';
import {Projects} from '../../../server/projects.mjs';
import {ProjectAssets} from '../../../server/project-assets/store.mjs';
import {StoryboardDatabase} from '../../../server/storyboard/database.mjs';
import {createStoryboardVideo} from '../../../server/storyboard-video/index.mjs';
import {ProjectVideos} from '../../../server/project-videos/store.mjs';
let lib,entry,catalog;
async function close(){await catalog?.close();await entry?.close();if(lib){const exited=lib.db.kind==='mysql'?once(lib.db.worker,'exit'):null;lib.db.close();if(exited)await exited;}}
try{
 lib=await new Library(workerData.dataDir).init();lib.enqueue=()=>{};lib.db.close();lib.db=new MysqlDatabase(workerData.config);
 new Projects(lib).init();const assets=new ProjectAssets(lib).init(),board=new StoryboardDatabase(lib,assets).init();entry=createStoryboardVideo({lib,storyboards:board,instanceId:'synthetic-instance'});catalog=new ProjectVideos(entry.store,{directory:workerData.directory});
 parentPort.once('message',async()=>{let result;try{const value=entry.bindingV2.select(workerData.projectId,workerData.input);result={ok:true,revision:value.context.selectionRevision};}catch(e){result={ok:false,code:e.code,status:e.status};}finally{await close();}parentPort.postMessage({...result,requestId:workerData.input.requestId});parentPort.close();});
 parentPort.postMessage({ready:true});
}catch(e){await close();parentPort.postMessage({ready:false,code:e.code,message:e.message});parentPort.close();}
