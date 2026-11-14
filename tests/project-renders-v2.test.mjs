import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fixture,imported,folder,uid,linkInput,link,settled,operation} from './helpers/project-render-fixture.mjs';
import {ProjectUsageJournal} from '../server/project-videos/action-journal.mjs';
import {canonical} from '../server/project-assets/model.mjs';

async function failed(f,source,extra,code){const input=linkInput(f,source,extra);let r;try{r=await f.renders.save(f.project.id,f.timelineId,input);}catch(e){assert.equal(e.code,code);assert.equal(e.accepted,true);assert.ok(e.details.statusUrl);r=f.renders.request(f.project.id,f.timelineId,input.requestId);}r=await settled(f,r);assert.equal(r.status,'failed');assert.equal(r.error.code,code);return r;}

test('unlinked fixed object, real source binding, legacy default and tombstone ABA',async t=>{
 const f=await fixture(t),r=await f.renders.get(f.project.id,f.timelineId,{schema:2});assert.equal(r.link,null);assert.equal(r.revision,0);assert.equal(await f.renders.get(f.project.id,f.timelineId),null);
 const s=await imported(f),done=await link(f,s),input=linkInput(f,s,{requestId:done.requestId,expectedRevision:0});
 assert.deepEqual(await f.renders.save(f.project.id,f.timelineId,input),done);
 assert.equal((await f.renders.get(f.project.id,f.timelineId)).path,s.path);const clear=await settled(f,await f.renders.remove(f.project.id,f.timelineId,{requestId:uid(),expectedRevision:1}));assert.equal(clear.result.render.revision,2);assert.equal(await f.renders.get(f.project.id,f.timelineId),null);
 await failed(f,s,{expectedRevision:0},'RENDER_CONFLICT');await link(f,s);assert.equal((await f.renders.get(f.project.id,f.timelineId,{schema:2})).revision,3);await fs.access(s.path);
});
test('source, timeline and render revisions compare-and-swap, one concurrent winner',async t=>{
 const f=await fixture(t),s=await imported(f);await failed(f,s,{expectedSourceRevision:999},'RENDER_CONFLICT');await failed(f,s,{expectedTimelineRevision:uid()},'RENDER_CONFLICT');
 const a=linkInput(f,s),b=linkInput(f,s),results=await Promise.allSettled([f.renders.save(f.project.id,f.timelineId,a),f.renders.save(f.project.id,f.timelineId,b)]);
 for(const x of results)if(x.status==='fulfilled')await settled(f,x.value);
 const receipts=[a,b].map(x=>f.renders.request(f.project.id,f.timelineId,x.requestId));assert.deepEqual(receipts.map(r=>r.status).sort(),['completed','failed']);assert.equal((await f.renders.get(f.project.id,f.timelineId,{schema:2})).revision,1);
});
test('unsupported, unknown, reject and missing candidates remain visible but cannot link',async t=>{
 const f=await fixture(t),s=await imported(f),base=JSON.parse(s.data_json),put=(patch)=>{f.lib.db.prepare('UPDATE storyboard_video_sources SET data_json=? WHERE id=?').run(canonical({...base,...patch}),s.id);const now=f.entry.store.source(f.project.id,s.id);f.entry.store.approve(now);f.catalog.approveManaged(now);};
 put({codec:'prores',supported:false});await failed(f,s,{},'RENDER_CODEC_UNSUPPORTED');put({codec:'unknown',supported:false});await failed(f,s,{},'RENDER_INFO_REQUIRED');
 const sources=await f.renders.sources(f.project.id,f.timelineId);assert.equal(sources.items[0].playback.supported,null);assert.equal(sources.items[0].selectable,false);put({});
 const reject=await folder(f,'废片');await operation(f,{kind:'move-video',sourceId:s.id,destinationFolderId:reject.id});const rev=f.catalog.folders.roleState(f.project.id).revision;f.catalog.folders.writeSettings(f.project.id,{...f.catalog.folders.settings(f.project.id),rejectFolderId:reject.id},rev);
 const list=await f.renders.sources(f.project.id,f.timelineId);assert.equal(list.items.length,1);assert.equal(list.items[0].inRejectArea,true);assert.equal(list.items[0].selectable,false);await failed(f,s,{},'RENDER_IN_REJECT_AREA');
 await fs.rename(f.entry.store.source(f.project.id,s.id).path,path.join(f.dir,'missing.mp4'));assert.equal((await f.renders.sources(f.project.id,f.timelineId)).items[0].availability,'missing');
});
test('lightweight reads never probe/hash/native and cannot ensure a final folder',async t=>{
 const f=await fixture(t),s=await imported(f);f.catalog.hash=()=>{throw Error('hash in read');};f.entry.media.probe=()=>{throw Error('probe in read');};f.catalog.desktop.capabilities=()=>{throw Error('native in read');};
 assert.equal((await f.renders.sources(f.project.id,f.timelineId)).items[0].sourceId,s.id);assert.equal((await f.renders.get(f.project.id,f.timelineId,{schema:2})).link,null);assert.equal(f.catalog.folders.settings(f.project.id).finalFolderId,null);assert.equal(f.catalog.folders.rows(f.project.id).length,0);
});
test('same source follows legal movement and title changes; timeline revision disables sync',async t=>{
 const f=await fixture(t),s=await imported(f);await link(f,s);const dest=await folder(f,'普通目录');assert.equal((await operation(f,{kind:'move-video',sourceId:s.id,destinationFolderId:dest.id})).status,'ready');
 const m=f.catalog.metadata(f.project.id,f.entry.store.source(f.project.id,s.id));f.catalog.record(f.project.id,s.id,{...m.data,title:'新标题'},m.row.revision+1);
 const r=await f.renders.get(f.project.id,f.timelineId,{schema:2});assert.equal(r.path,path.join(dest.path,s.name));assert.equal(r.name,'新标题');assert.equal(r.sync.state,'aligned');
 f.lib.db.prepare('UPDATE project_timelines SET revision=? WHERE id=?').run(uid(),f.timelineId);assert.equal((await f.renders.get(f.project.id,f.timelineId,{schema:2})).sync.state,'timeline_changed');
});
test('stat-only drift is review, confirmed metadata remains same content, replacement never inherits',async t=>{
 const f=await fixture(t),s=await imported(f);await link(f,s);await fs.utimes(s.path,new Date(),new Date(Date.now()+5000));
 let r=await f.renders.get(f.project.id,f.timelineId,{schema:2});assert.equal(r.verification.state,'needs_verification');assert.equal(r.playback.canPlay,false);
 const opened=await f.renders.open(f.project.id,f.timelineId);await f.entry.media.release(opened.handle);r=await f.renders.get(f.project.id,f.timelineId,{schema:2});assert.equal(r.sync.state,'aligned');
 await fs.rename(s.path,path.join(f.dir,'saved.mp4'));await fs.writeFile(s.path,f.bytes);r=await f.renders.get(f.project.id,f.timelineId,{schema:2});assert.equal(r.verification.state,'needs_verification');await assert.rejects(f.renders.open(f.project.id,f.timelineId),{code:'RENDER_SOURCE_REVIEW_REQUIRED'});
});
test('request conflict, other timeline/project isolation and restart unknown never replay',async t=>{
 const f=await fixture(t),s=await imported(f),input=linkInput(f,s);await settled(f,await f.renders.save(f.project.id,f.timelineId,input));await assert.rejects(f.renders.save(f.project.id,f.timelineId,{...input,offset:1}),{code:'REQUEST_ID_CONFLICT'});
 assert.throws(()=>f.catalog.usageJournal.row(f.project.id,input.requestId,null),{code:'OPERATION_NOT_FOUND'});assert.throws(()=>f.catalog.usageJournal.row(f.other.id,input.requestId,f.timelineId),{code:'OPERATION_NOT_FOUND'});
 const requestId=uid(),record={namespace:'project-usage-render-v1',kind:'render-link',action:'render-link',scope:'render:'+f.timelineId,requestId,projectId:f.project.id,timelineId:f.timelineId,status:'running',args:'synthetic',result:null,error:null};f.lib.db.prepare('INSERT INTO project_video_operations VALUES(?,?,?,?,?)').run(requestId,f.project.id,canonical(record),1,1);
 f.catalog.usageJournal=new ProjectUsageJournal(f.catalog);assert.equal(f.renders.request(f.project.id,f.timelineId,requestId).status,'unknown');await failed(f,s,{},'RENDER_OPERATION_UNSETTLED');
});
test('late XML edit and permission change cannot commit a checked source',async t=>{
 const f=await fixture(t),s=await imported(f),hash=f.catalog.hash.bind(f.catalog);let inject=true;f.catalog.hash=async(...args)=>{const r=await hash(...args);if(inject){inject=false;f.lib.db.prepare('UPDATE project_timelines SET revision=? WHERE id=?').run(uid(),f.timelineId);}return r;};
 await failed(f,s,{},'RENDER_CONFLICT');assert.equal(f.renders.row(f.project.id,f.timelineId),undefined);
});
test('legacy path only reads original identity; new path writes rejected without IO',async t=>{
 const f=await fixture(t),st=await fs.stat(f.file),old={path:f.file,offset:3,dev:String(st.dev),ino:String(st.ino),size:st.size,mtime:st.mtimeMs,updatedAt:Date.now()};
 f.lib.db.prepare('INSERT INTO project_renders VALUES(?,?,?,?)').run(f.timelineId,f.project.id,JSON.stringify(old),1);
 const r=await f.renders.get(f.project.id,f.timelineId,{schema:2});assert.equal(r.link,'legacy-path');assert.equal(r.playback.canPlay,true);assert.equal(r.sync.canSynchronize,false);const opened=await f.renders.open(f.project.id,f.timelineId);await f.entry.media.release(opened.handle);
 await assert.rejects(f.renders.save(f.project.id,f.timelineId,{requestId:uid(),path:f.file}),{code:'RENDER_PATH_NOT_ALLOWED'});await fs.rename(f.file,f.file+'-old');await fs.writeFile(f.file,f.bytes);await assert.rejects(f.renders.open(f.project.id,f.timelineId),{code:'RENDER_LEGACY_REVIEW_REQUIRED'});
});

test('concurrent root revision and real approval revocation cannot bypass authority CAS',async t=>{
 const f=await fixture(t),s=await imported(f),hash=f.catalog.hash.bind(f.catalog);let touched=false;f.catalog.hash=async(...a)=>{const r=await hash(...a);if(!touched){touched=true;f.lib.db.prepare('UPDATE roots SET revision=revision+1,reconciled_ms=?').run(Date.now());}return r;};await failed(f,s,{},'RENDER_CONFLICT');f.catalog.hash=hash;await link(f,s);
 const g=await fixture(t),v=await imported(g),check=g.catalog.hash.bind(g.catalog);let revoke=false;g.catalog.hash=async(...a)=>{const r=await check(...a);if(!revoke){revoke=true;g.lib.db.prepare('DELETE FROM storyboard_video_approvals WHERE id=?').run(v.id);}return r;};const input=linkInput(g,v);let r;try{r=await g.renders.save(g.project.id,g.timelineId,input);}catch(e){assert.ok(['RENDER_CONFLICT','RENDER_SOURCE_UNTRUSTED'].includes(e.code));r=g.renders.request(g.project.id,g.timelineId,input.requestId);}r=await settled(g,r);assert.equal(r.status,'failed');assert.equal(g.renders.row(g.project.id,g.timelineId),undefined);
});
