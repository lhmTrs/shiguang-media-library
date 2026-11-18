import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {once} from 'node:events';
import Database from 'better-sqlite3';
import {legacyVideoLibrary} from './helpers/video-v2-legacy-library.mjs';
import {ownedVideoServer,bounded} from './helpers/video-v2-owned-server.mjs';
import {upgradePolicy} from '../server/storyboard-video-v2/upgrade-policy.mjs';
import {hash} from '../server/storyboard-video-v2/model.mjs';
for(const policyExists of [false,true])test('actual SIGTERM inside last policy IO preserves old rows and request until restart: '+(policyExists?'existing policy':'ENOENT'),async t=>{
 const f=await legacyVideoLibrary(t);if(policyExists)await upgradePolicy({dataDir:f.lib.dataDir,instanceId:f.instanceId,mode:'automatic',reason:'synthetic normal startup'});await f.closeForServer();let server=await ownedVideoServer(f,{policyIO:true});
 try{
  const [message]=await bounded(once(server.child,'message'),10000,'owned policy IO handshake timeout');assert.equal(message.phase,'delete-policy-await');await server.stop();
  const db=new Database(path.join(f.lib.dataDir,'library.sqlite'),{readonly:true});try{for(const [table,rows]of Object.entries(f.legacy))assert.deepEqual(db.prepare('SELECT * FROM '+table+' ORDER BY id').all(),rows);assert.equal(JSON.parse(db.prepare("SELECT data_json FROM storyboard_video_v2_state WHERE id='migration'").get().data_json).status,'pending');assert.equal(db.prepare('SELECT COUNT(*) n FROM storyboard_video_v2_requests').get().n,0);}finally{db.close();}
  const file=path.join(f.lib.dataDir,'video-binding-v2','startup-'+hash(f.instanceId)+'.json'),before=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(before.status,'failed');assert.equal(before.reasonCode,'VIDEO_V2_UPGRADE_STOPPED');assert.deepEqual(await fs.readFile(f.source.path),f.bytes);
  server=await ownedVideoServer(f);const api=await server.ready();assert.equal((await api('/storyboard-video/v2/projects/'+f.a.id+'/state')).migration.status,'complete');const after=JSON.parse(await fs.readFile(file,'utf8'));assert.equal(after.requestId,before.requestId);assert.equal(after.exportHash,before.exportHash);
 }finally{await server.stop();}
});
