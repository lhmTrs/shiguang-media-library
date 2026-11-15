import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fixture,uid,folder,settled,imported} from './helpers/project-render-fixture.mjs';
import {canonical} from '../server/project-assets/model.mjs';
import {FileIntake} from '../server/file-intake/store.mjs';
import {ManagedIntakeCatalog} from '../server/file-intake/media-catalog.mjs';
import {checkChoice} from '../server/file-intake/names.mjs';
import {preferenceTarget} from '../server/file-intake/preferences.mjs';
const ensure=(f,extra={})=>f.catalog.finalFolder.ensure(f.project.id,{requestId:uid(),expectedRolesRevision:f.catalog.folders.roleState(f.project.id).revision,...extra});

test('reads/preview do not create; explicit ensure creates once and replay is historical',async t=>{
 const f=await fixture(t),root=await f.catalog.folders.rootPath(f.project.id);const plan=await f.catalog.finalFolder.preview(f.project.id);assert.equal(plan.outcome,'created');await assert.rejects(fs.access(root));
 const input={requestId:uid(),expectedRolesRevision:0},a=await settled(f,await f.catalog.finalFolder.ensure(f.project.id,input));assert.equal(a.status,'completed');assert.equal(a.result.outcome,'created');assert.equal(a.result.created,true);assert.equal(a.result.folder.locked,true);
 assert.deepEqual(await f.catalog.finalFolder.ensure(f.project.id,input),a);const b=await settled(f,await ensure(f));assert.equal(b.result.outcome,'existing');assert.equal(b.result.folder.id,a.result.folder.id);assert.equal(b.result.folderRoles.revision,1);
});
test('ordinary registered and unregistered root folders auto-adopt without moving contents',async t=>{
 for(const registered of [false,true]){const f=await fixture(t);let existing;if(registered)existing=await folder(f,'成片');else{const root=await f.catalog.prepareRoot(f.project.id);await fs.mkdir(path.join(root.target,'成片'));}
 const dir=path.join(await f.catalog.folders.rootPath(f.project.id),'成片');await fs.writeFile(path.join(dir,'keep.txt'),'untouched');const before=await fs.stat(dir),result=await settled(f,await ensure(f));assert.equal(result.result.outcome,'adopted');assert.equal(result.result.contentsMoved,false);assert.equal((await fs.stat(dir)).ino,before.ino);assert.equal(await fs.readFile(path.join(dir,'keep.txt'),'utf8'),'untouched');if(existing)assert.equal(result.result.folder.id,existing.id);}
});
test('registered final Finder rename+refresh remains needs_review and old ID is never reassigned',async t=>{
 const f=await fixture(t),done=await settled(f,await ensure(f)),id=done.result.folder.id,original=path.join(await f.catalog.folders.rootPath(f.project.id),'成片');await fs.rename(original,original+'-old');await fs.mkdir(original);await f.catalog.folders.refresh(f.project.id,'root');
 const state=await f.catalog.finalFolder.roles(f.project.id);assert.equal(state.finalState,'needs_review');assert.equal(state.finalFolderId,id);assert.equal(f.catalog.folders.row(f.project.id,id).relativePath,'成片');
 try{const r=await settled(f,await ensure(f));assert.equal(r.status,'failed');assert.equal(r.error.code,'FINAL_FOLDER_NEEDS_REVIEW');}catch(e){assert.equal(e.code,'FINAL_FOLDER_NEEDS_REVIEW');assert.equal(e.accepted,true);}
 assert.equal((await fs.readdir(original)).length,0);assert.equal((await f.catalog.list(f.project.id,{folderId:'all'})).folderRoles.finalState,'needs_review');
});
test('symlink/file/multiple/reject collision and roles CAS reject with durable receipts',async t=>{
 for(const type of ['link','file','reject','multiple']){const f=await fixture(t),root=await f.catalog.prepareRoot(f.project.id),target=path.join(root.target,'成片');
 if(type==='link')await fs.symlink(f.dir,target);if(type==='file')await fs.writeFile(target,'not-directory');if(type==='reject'){const row=await folder(f,'成片');f.catalog.folders.writeSettings(f.project.id,{...f.catalog.folders.settings(f.project.id),rejectFolderId:row.id},0);}if(type==='multiple'){await fs.mkdir(target);f.catalog.folders.write(f.project.id,uid(),{name:'成片',parentId:'root',relativePath:'成片',identity:{dev:'x',ino:'x'},removedAt:0});f.catalog.folders.write(f.project.id,uid(),{name:'成片',parentId:'root',relativePath:'成片',identity:{dev:'y',ino:'y'},removedAt:0});}
 let r;try{r=await settled(f,await ensure(f));assert.equal(r.status,'failed');assert.equal(r.error.code,'FINAL_FOLDER_NAME_CONFLICT');}catch(e){assert.equal(e.code,'FINAL_FOLDER_NAME_CONFLICT');assert.equal(e.accepted,true);}}
 const f=await fixture(t);await assert.rejects(ensure(f,{expectedRolesRevision:9}),{code:'FOLDER_ROLES_CONFLICT'});assert.equal(f.catalog.folders.roleState(f.project.id).finalFolderId,null);
});
test('concurrent same request creates once; interrupted IO forbids replacement ensure',async t=>{
 const f=await fixture(t),input={requestId:uid(),expectedRolesRevision:0},results=await Promise.all([f.catalog.finalFolder.ensure(f.project.id,input),f.catalog.finalFolder.ensure(f.project.id,input)]);const [a,b]=await Promise.all(results.map(r=>settled(f,r)));assert.equal(a.result.folder.id,b.result.folder.id);assert.equal(f.catalog.folders.rows(f.project.id).length,1);
 const g=await fixture(t),requestId=uid();g.lib.db.prepare('INSERT INTO project_video_operations VALUES(?,?,?,?,?)').run(requestId,g.project.id,canonical({namespace:'project-usage-render-v1',kind:'final-folder-ensure',action:'final-folder-ensure',scope:'final',projectId:g.project.id,timelineId:null,requestId,status:'running'}),1,1);
 const unknown=g.catalog.usageJournal.dto(g.catalog.usageJournal.row(g.project.id,requestId));assert.equal(unknown.status,'unknown');assert.deepEqual(unknown.result,{created:null,adopted:null,contentsMoved:false});await assert.rejects(ensure(g),{code:'FINAL_FOLDER_OPERATION_UNSETTLED'});await assert.rejects(fs.access(await g.catalog.folders.rootPath(g.project.id)));
});
test('final logical intake target is exclusive, read-only planning and existing sequence naming',async t=>{
 const f=await fixture(t),generic=await new ManagedIntakeCatalog({catalog:f.catalog,assets:f.assets,dataDir:f.lib.dataDir,directory:path.join(f.dir,'personal_item')}).init(),intake=await new FileIntake({dataDir:f.lib.dataDir,libraryId:'synthetic',catalog:f.catalog,projects:f.projects,generic}).init();t.after(()=>intake.close());
 const destination={kind:'video',scope:'project',projectId:f.project.id,folderRole:'final'};checkChoice({name:'clip.mp4',mediaKind:'video'},{destination});assert.throws(()=>checkChoice({name:'clip.mp4',mediaKind:'video'},{destination:{...destination,folderId:'root'}}));assert.deepEqual(preferenceTarget(destination),destination);
 const plan=await intake.videoNameTarget(destination);assert.equal(plan.folder.relativePath,'成片');await plan.verify();await assert.rejects(fs.access(plan.directory));
 const result=await f.catalog.finalFolder.ensureResolved(f.project.id,{requestId:uid(),expectedRolesRevision:0});const source=await imported(f,'old_009.mp4',result.folder.id);assert.equal((await fs.stat(source.path)).isFile(),true);
 const legacyStat=await fs.stat(f.file);f.lib.db.prepare('INSERT INTO project_renders VALUES(?,?,?,?)').run(f.timelineId,f.project.id,JSON.stringify({path:f.file,offset:0,dev:String(legacyStat.dev),ino:String(legacyStat.ino),size:legacyStat.size,mtime:legacyStat.mtimeMs,updatedAt:Date.now()}),1);
 const h=await intake.receipts.handoff([f.file]),input={version:2,requestId:uid(),mode:'copy',fileIds:h.files.map(v=>v.id),targets:h.files.map(v=>({fileId:v.id,destination,nameMode:'standard'})),standardNames:true};
 const batch=await intake.confirm(h.id,input);assert.deepEqual(batch.items[0].destination,destination);assert.equal(batch.items[0].resolvedFolder.id,result.folder.id);
 for(let n=0;intake.work||intake.status().activeCount;n++){assert.ok(n<500);await new Promise(r=>setTimeout(r,10));}
 const done=await intake.confirm(h.id,input);assert.deepEqual(done.items[0].destination,destination);assert.equal(done.items[0].status,'ready',done.items[0].error);assert.match(done.items[0].resultFileName,/_010\.mp4$/);
 assert.equal((await f.renders.get(f.project.id,f.timelineId,{schema:2})).playback.canPlay,true);
 const disk=await intake.receipts.read('batches',batch.id);assert.deepEqual(disk.items[0].destination,destination);assert.equal(disk.items[0].resolvedFolder.id,result.folder.id);
 const options=await intake.routingOptions();assert.equal(options.projects.find(p=>p.id===f.project.id).videoFolders.find(d=>d.id===result.folder.id).role,'final');
});

test('ensure commit ACK loss reads durable completion; uncertain mkdir remains query-only',async t=>{
 const f=await fixture(t),tx=f.catalog.videos.tx.bind(f.catalog.videos);let lost=false;
 f.catalog.videos.tx=fn=>{const value=tx(fn);if(!lost){lost=true;throw Error('synthetic lost commit acknowledgement');}return value;};
 const result=await settled(f,await ensure(f));assert.equal(result.status,'completed');assert.equal(result.result.created,true);assert.equal(f.catalog.folders.rows(f.project.id).length,1);
 const g=await fixture(t),write=g.catalog.folders.write.bind(g.catalog.folders);g.catalog.folders.write=()=>{throw Error('synthetic metadata failure after mkdir');};
 const unknown=await settled(g,await ensure(g));assert.equal(unknown.status,'unknown');assert.equal(unknown.result.created,null);assert.equal((await fs.stat(path.join(await g.catalog.folders.rootPath(g.project.id),'成片'))).isDirectory(),true);g.catalog.folders.write=write;
 await assert.rejects(ensure(g),{code:'FINAL_FOLDER_OPERATION_UNSETTLED'});assert.equal(g.catalog.folders.settings(g.project.id).finalFolderId,null);
});
