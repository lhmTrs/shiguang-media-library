import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture,imported,initialize,bind} from './helpers/project-video-desktop-fixture.mjs';

const folder=(f,name,parentId='root')=>f.catalog.folders.create(f.project.id,{requestId:randomUUID(),name,parentId});
async function role(f,folderId){
 const p=await f.catalog.rejectArea.preview(f.project.id,{requestId:randomUUID(),folderId,expectedRolesRevision:f.catalog.folders.roleState(f.project.id).revision});
 await f.catalog.rejectArea.execute(f.project.id,{requestId:p.requestId,previewHash:p.previewHash,confirmRoleChange:true,confirmUnbind:true,confirmedUnbindShotIds:p.affectedShots.map(x=>x.id)});
 await f.catalog.rejectArea.active.get(p.requestId);
 const s=f.catalog.rejectArea.row(f.project.id,p.requestId);assert.equal(s.status,'ready',s.error);return s;
}
async function preview(f,input){return f.catalog.fileOperations.preview(f.project.id,{requestId:randomUUID(),expectedRolesRevision:f.catalog.folders.roleState(f.project.id).revision,...input});}
async function finish(f,p,extra={}){
 await f.catalog.fileOperations.execute(f.project.id,{requestId:p.requestId,previewHash:p.previewHash,confirmUnbind:true,confirmedUnbindShotIds:p.affectedShots.map(x=>x.id),...extra});
 await f.catalog.queue;
 const s=f.catalog.fileOperations.row(f.project.id,p.requestId);return f.catalog.fileOperations.dto(p.requestId,s);
}

test('reject move requires exact union confirmation; sources, takes and shot content survive',async t=>{
 const f=await fixture(t);initialize(f);const area=await folder(f,'废片'),child=await folder(f,'第二轮',area.id);await role(f,area.id);
 const a=await imported(f,'a.mp4'),b=await imported(f,'b.mp4');await bind(f,a,[0,1]);await bind(f,b,[2]);
 const before=await f.entry.store.state(f.project.id),head=f.storyboards.head(f.project.id),meta=f.catalog.metadata(f.project.id,a).data;
 await assert.rejects(preview(f,{kind:'move-video',sourceId:a.id,destinationFolderId:child.id}),e=>e.code==='UNBIND_MODE_REQUIRED');
 const p=await preview(f,{kind:'move-videos',sourceIds:[a.id,b.id],destinationFolderId:child.id,unbindAdoptions:true});
 assert.equal(p.sourceUnbindShots.length,3);assert.equal(p.overwriteTargetUnbindShots.length,0);
 await assert.rejects(f.catalog.fileOperations.execute(f.project.id,{requestId:p.requestId,previewHash:p.previewHash,confirmUnbind:true,confirmedUnbindShotIds:p.affectedShots.slice(0,1).map(x=>x.id)}),e=>e.code==='UNBIND_CONFIRMATION_REQUIRED');
 await fs.access(a.path);assert.equal(Object.keys((await f.entry.store.state(f.project.id)).plan.adopted).length,3);
 const done=await finish(f,p);assert.equal(done.status,'ready',done.error);assert.deepEqual(done.items.map(x=>x.status),['ready','ready']);
 const after=await f.entry.store.state(f.project.id);assert.equal(Object.keys(after.plan.adopted).length,0);assert.deepEqual(after.shots,before.shots);assert.deepEqual(after.takes,before.takes);assert.equal(f.storyboards.head(f.project.id).revision,head.revision);
 const moved=f.entry.store.source(f.project.id,a.id);assert.equal(path.dirname(moved.path),child.path);assert.equal(f.catalog.metadata(f.project.id,moved).data.promptId,meta.promptId);assert.equal(f.catalog.metadata(f.project.id,moved).data.removedAt,0);
 assert.equal((await f.catalog.list(f.project.id,{folderId:'all'})).videos.length,0);assert.equal((await f.catalog.list(f.project.id,{folderId:'reject'})).videos.length,2);
 const back=await preview(f,{kind:'move-video',sourceId:a.id,destinationFolderId:'root'});assert.equal((await finish(f,back)).status,'ready');assert.equal(Object.keys((await f.entry.store.state(f.project.id)).plan.adopted).length,0);
});

test('overwrite union includes both moving sources and adopted target, only target is retired',async t=>{
 const f=await fixture(t);initialize(f);const area=await folder(f,'废片');await role(f,area.id);
 const target=await imported(f,'same.mp4',area.id),source=await imported(f,'same.mp4');await bind(f,target,[1]);await bind(f,source,[0]);
 const p=await preview(f,{kind:'move-videos',sourceIds:[source.id],destinationFolderId:area.id,unbindAdoptions:true,choices:{[source.id]:'overwrite'}});
 assert.equal(p.sourceUnbindShots.length,1);assert.equal(p.overwriteTargetUnbindShots.length,1);assert.equal(p.affectedShots.length,2);assert.deepEqual(new Set(p.affectedShots.flatMap(x=>x.sourceIds)),new Set([source.id,target.id]));
 const done=await finish(f,p);assert.equal(done.status,'ready',done.error);assert.equal(f.catalog.metadata(f.project.id,f.entry.store.source(f.project.id,source.id)).data.removedAt,0);assert.ok(f.catalog.metadata(f.project.id,f.entry.store.source(f.project.id,target.id)).data.removedAt>0);assert.equal(Object.keys((await f.entry.store.state(f.project.id)).plan.adopted).length,0);
});

test('same-batch name collisions cannot overwrite another selected file; suffixes start at zero',async t=>{
 const f=await fixture(t),aFolder=await folder(f,'甲'),bFolder=await folder(f,'乙'),area=await folder(f,'废片');await role(f,area.id);
 const a=await imported(f,'same.mp4',aFolder.id),b=await imported(f,'same.mp4',bFolder.id),input={kind:'move-videos',sourceIds:[a.id,b.id],destinationFolderId:area.id,unbindAdoptions:true};
 await assert.rejects(preview(f,{...input,choices:{[b.id]:'overwrite'}}),e=>e.code==='BATCH_TARGET_CONFLICT');
 const unresolved=await preview(f,input);assert.equal(unresolved.ready,false);assert.equal(unresolved.conflicts[0].key,b.id);
 const p=await preview(f,{...input,choices:{[b.id]:'rename'}}),done=await finish(f,p);assert.equal(done.status,'ready',done.error);assert.equal(path.basename(f.entry.store.source(f.project.id,b.id).path),'same_0.mp4');
 await assert.rejects(preview(f,{...input,sourceIds:[a.id,a.id]}),e=>e.code==='INVALID_SOURCE_IDS');
 await assert.rejects(preview(f,{...input,sourceIds:Array.from({length:51},()=>randomUUID())}),e=>e.code==='INVALID_SOURCE_IDS');
});

test('fresh adoption or role setting invalidates frozen batch without moving bytes or detaching shots',async t=>{
 const f=await fixture(t);initialize(f);const area=await folder(f,'废片'),other=await folder(f,'另一个收纳处');await role(f,area.id);const a=await imported(f,'a.mp4');
 let p=await preview(f,{kind:'move-videos',sourceIds:[a.id],destinationFolderId:area.id,unbindAdoptions:true});await bind(f,a,[0]);
 let done=await finish(f,p);assert.equal(done.status,'failed');await fs.access(a.path);assert.equal(Object.keys((await f.entry.store.state(f.project.id)).plan.adopted).length,1);
 p=await preview(f,{kind:'move-videos',sourceIds:[a.id],destinationFolderId:area.id,unbindAdoptions:true});await role(f,other.id);done=await finish(f,p);assert.equal(done.status,'failed');await fs.access(a.path);assert.equal(Object.keys((await f.entry.store.state(f.project.id)).plan.adopted).length,1);
});

test('known failure rolls back earlier moves, preserves adoptions, original ID does not execute again',async t=>{
 const f=await fixture(t);initialize(f);const area=await folder(f,'废片');await role(f,area.id);const a=await imported(f,'a.mp4'),b=await imported(f,'b.mp4'),c=await imported(f,'c.mp4');await bind(f,a,[0]);
 const p=await preview(f,{kind:'move-videos',sourceIds:[a.id,b.id,c.id],destinationFolderId:area.id,unbindAdoptions:true}),step=f.catalog.fileOperations.step.bind(f.catalog.fileOperations);let calls=0;
 f.catalog.fileOperations.step=async(...args)=>{if(++calls===2)throw Error('synthetic second move failed');return step(...args);};
 const done=await finish(f,p);assert.equal(done.status,'failed',done.error);assert.deepEqual(done.items.map(x=>x.status),['rolled-back','failed','not-run']);for(const s of [a,b,c])await fs.access(s.path);assert.equal(Object.keys((await f.entry.store.state(f.project.id)).plan.adopted).length,1);
 assert.equal((await finish(f,p)).status,'failed');assert.equal(calls,2);
});

test('unsettled rollback stays UNKNOWN, stops later item and preserves source IDs and adopted plan',async t=>{
 const f=await fixture(t);initialize(f);const area=await folder(f,'废片');await role(f,area.id);const a=await imported(f,'a.mp4'),b=await imported(f,'b.mp4');await bind(f,a,[0]);
 const p=await preview(f,{kind:'move-videos',sourceIds:[a.id,b.id],destinationFolderId:area.id,unbindAdoptions:true}),step=f.catalog.fileOperations.step.bind(f.catalog.fileOperations);let calls=0;
 f.catalog.fileOperations.step=async(...args)=>{calls++;await step(...args);await fs.writeFile(args[4],Buffer.from('synthetic late external replacement'));throw Error('synthetic after first move');};
 const done=await finish(f,p);assert.equal(done.status,'unknown');assert.equal(done.items[0].status,'unknown');assert.equal(done.items[1].status,'not-run');assert.equal(calls,1);await fs.access(b.path);assert.equal(f.entry.store.source(f.project.id,a.id).path,a.path);assert.equal(Object.keys((await f.entry.store.state(f.project.id)).plan.adopted).length,1);assert.equal((await finish(f,p)).status,'unknown');assert.equal(calls,1);
});

test('folder carrying adopted video cannot enter reject area; deleting ancestor clears role only on success',async t=>{
 const f=await fixture(t);initialize(f);const shell=await folder(f,'外壳'),area=await folder(f,'废片',shell.id),ordinary=await folder(f,'普通'),a=await imported(f,'a.mp4',ordinary.id);await role(f,area.id);await bind(f,a,[0]);
 await assert.rejects(preview(f,{kind:'move-folder',folderId:ordinary.id,destinationFolderId:area.id}),e=>e.code==='ADOPTED_FOLDER_MOVE_REJECTED');
 const cancelled=await preview(f,{kind:'delete-folder',folderId:shell.id,mode:'contents-to-root'});assert.equal(f.catalog.folders.roleState(f.project.id).rejectFolderId,area.id);
 const done=await finish(f,cancelled);assert.equal(done.status,'ready',done.error);assert.equal(f.catalog.folders.roleState(f.project.id).rejectFolderId,null);assert.equal(f.catalog.folders.row(f.project.id,area.id).parentId,'root');
});

test('one shot spanning two video sources is wholly unadopted, both original segments remain',async t=>{
 const f=await fixture(t);initialize(f);const area=await folder(f,'废片');await role(f,area.id);const a=await imported(f,'part-a.mp4'),b=await imported(f,'part-b.mp4');
 let state=await f.entry.store.state(f.project.id);const checked={items:(await Promise.all([a,b].map(s=>f.entry.store.inspect(f.project.id,[{sourceId:s.id}])))).flatMap(x=>x.items)};
 await f.entry.store.import(f.project.id,{requestId:randomUUID(),guards:{documentId:state.documentId,initializedAt:state.initializedAt,expectedStoryboardRevision:state.storyboardRevision,expectedPlanRevision:state.plan.revision,timingHash:state.timingHash},shotIds:[state.shots[0].id],videos:checked.items.map(x=>({token:x.token,inMs:0,outMs:500}))});
 state=await f.entry.store.state(f.project.id);const shot=state.shots[0],take=state.takes.find(x=>x.takeId===state.plan.adopted[shot.id]);assert.equal(take.segments.length,2);
 const p=await preview(f,{kind:'move-video',sourceId:a.id,destinationFolderId:area.id,unbindAdoptions:true}),done=await finish(f,p);assert.equal(done.status,'ready',done.error);
 const after=await f.entry.store.state(f.project.id);assert.equal(after.plan.adopted[shot.id],undefined);assert.deepEqual(after.takes.find(x=>x.takeId===take.takeId),take);assert.equal(f.entry.store.source(f.project.id,b.id).path,b.path);
});

test('batch HTTP preview/execute/query uses one request and rejects incomplete confirmation without IO',async t=>{
 const {default:express}=await import('express');const {createServer}=await import('node:http');const {projectVideoRouter}=await import('../server/project-videos/router.mjs');
 const f=await fixture(t);initialize(f);const area=await folder(f,'废片');await role(f,area.id);const a=await imported(f,'http-a.mp4'),b=await imported(f,'http-b.mp4');await bind(f,a,[0]);
 const app=express();app.use('/api/project-videos',projectVideoRouter(f.catalog));app.use((e,_q,res,_next)=>res.status(e.status||500).json({code:e.code,error:e.message}));
 const server=createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));});
 const url=`http://127.0.0.1:${server.address().port}/api/project-videos/projects/${f.project.id}`;
 const post=(route,body)=>fetch(url+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),requestId=randomUUID();
 const response=await post('/operations/preview',{requestId,kind:'move-videos',sourceIds:[a.id,b.id],destinationFolderId:area.id,unbindAdoptions:true,expectedRolesRevision:f.catalog.folders.roleState(f.project.id).revision});assert.equal(response.status,200);const p=await response.json();
 assert.equal((await post('/operations',{requestId,previewHash:p.previewHash,confirmUnbind:true,confirmedUnbindShotIds:[]})).status,409);await fs.access(a.path);
 const body={requestId,previewHash:p.previewHash,confirmUnbind:true,confirmedUnbindShotIds:p.affectedShots.map(x=>x.id)};assert.equal((await post('/operations',body)).status,200);await f.catalog.queue;
 const done=await (await fetch(url+'/operations/'+requestId)).json();assert.equal(done.status,'ready',done.error);assert.deepEqual(done.items.map(x=>x.sourceId),[a.id,b.id]);assert.deepEqual((await (await post('/operations',body)).json()),done);
});
