import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {videoV2Fixture} from './video-binding-v2-fixture.mjs';
import {V2_TABLES} from '../../server/storyboard-video-v2/schema.mjs';
import {canonical} from '../../server/storyboard-video-v2/model.mjs';

export async function legacyVideoLibrary(t,{nativeStorage=null}={}){
 let cleanup,closed=false;const f=await videoV2Fixture({after:fn=>cleanup=fn});
 t.after(async()=>{if(closed)await fs.rm(f.dir,{recursive:true,force:true});else await cleanup();});
 const instanceId=randomUUID();await fs.writeFile(path.join(f.lib.dataDir,'mysql-source-id'),instanceId,{mode:0o600});
 f.initialize();const video=await f.imported(),current=f.entry.store.current(f.a.id),takeId=randomUUID(),requestId=randomUUID(),now=Date.now();
 f.db.prepare('INSERT INTO storyboard_video_takes VALUES(?,?,?,?,?,?,?,?,?)').run(takeId,f.a.id,current.documentId,current.initializedAt,'shot_0',1,canonical({segments:[{sourceId:video.videoId,inMs:0,outMs:1000}],alignment:'estimated',timingHash:current.timingHash}),now,now);
 f.db.prepare('INSERT INTO storyboard_video_plans VALUES(?,?,?,?,?,?,?,?)').run(f.a.id,current.documentId,current.initializedAt,1,current.timingHash,canonical({adopted:{shot_0:takeId}}),now,now);
 f.db.prepare('INSERT INTO storyboard_video_requests VALUES(?,?,?,?,?,?,?,?)').run(requestId,f.a.id,current.documentId,current.initializedAt,'a'.repeat(64),canonical({receipt:{requestId,planRevision:1,takeIds:[takeId],sourceIds:[video.videoId],adoptedShotIds:['shot_0']},before:{}}),now,now);
 if(nativeStorage){const storage=await nativeStorage(f);await storage.activate();f.db=f.lib.db;}
 f.v2._instanceId=instanceId;
 for(const table of Object.keys(V2_TABLES))f.db.exec('DROP TABLE '+table);f.v2.checkedDb=null;
 const legacy=f.v2.legacyRows(),source=f.entry.store.source(f.a.id,video.videoId);
 const closeForServer=async()=>{await f.catalog.close();await f.entry.close();const exited=f.lib.db.kind==='mysql'?once(f.lib.db.worker,'exit'):null;f.lib.db.close();if(exited)await exited;closed=true;};
 return Object.assign(f,{instanceId,video,legacy,source,closeForServer});
}
