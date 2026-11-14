import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fixture,uid,imported,folder,link,linkInput,settled,operation} from './helpers/project-render-fixture.mjs';
import {canonical} from '../server/project-assets/model.mjs';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {existsSync} from 'node:fs';
import {DirectoryClassification} from '../server/directory-classification.mjs';

async function legacy(f,file,tid=f.timelineId){const st=await fs.stat(file),p={path:file,offset:0,dev:String(st.dev),ino:String(st.ino),size:st.size,mtime:st.mtimeMs,updatedAt:Date.now()};f.lib.db.prepare('INSERT INTO project_renders(id,project_id,payload,revision) VALUES(?,?,?,?)').run(tid,f.project.id,JSON.stringify(p),1);}
const rejectRole=(f,dir)=>{f.catalog.folders.writeSettings(f.project.id,{...f.catalog.folders.settings(f.project.id),rejectFolderId:dir.id},f.catalog.folders.roleState(f.project.id).revision);};

test('final rename/move/delete/batch-parent previews and stale previews are locked',async t=>{
 const f=await fixture(t),plain=await folder(f,'成片'),other=await folder(f,'其它'),before=await f.catalog.fileOperations.preview(f.project.id,{requestId:uid(),kind:'rename-folder',folderId:plain.id,name:'更名'});
 const result=await f.catalog.finalFolder.ensureResolved(f.project.id,{requestId:uid(),expectedRolesRevision:0});assert.equal(result.folder.id,plain.id);
 for(const kind of ['rename-folder','move-folder','delete-folder'])await assert.rejects(f.catalog.fileOperations.preview(f.project.id,{requestId:uid(),kind,folderId:plain.id,name:'更名',destinationFolderId:other.id,mode:kind==='delete-folder'?'contents-to-root':undefined}),{code:'FOLDER_RESERVED'});
 await f.catalog.fileOperations.execute(f.project.id,{requestId:before.requestId,previewHash:before.previewHash});await f.catalog.queue;const row=f.catalog.fileOperations.row(f.project.id,before.requestId);assert.equal(row.status,'failed');assert.match(row.error,/保留文件夹/);await fs.access(plain.path);
 await assert.rejects(f.catalog.rejectArea.preview(f.project.id,{requestId:uid(),expectedRolesRevision:1,folderId:plain.id}),{code:'FOLDER_RESERVED'});
});
test('linked videos reject remove/accept/overwrite and move-to-reject including folder parent',async t=>{
 const f=await fixture(t),a=await folder(f,'普通'),s=await imported(f,'same.mp4',a.id),reject=await folder(f,'废片');rejectRole(f,reject);await link(f,s);
 assert.throws(()=>f.catalog.remove(f.project.id,s.id,{expectedRevision:1,adoptionStamp:f.catalog.adoption(f.project.id).stamp}),{code:'RENDER_IN_USE'});
 assert.throws(()=>f.catalog.changes.removePreview(f.project.id,s.id,{requestId:uid(),expectedRevision:1}),{code:'RENDER_IN_USE'});
 assert.throws(()=>f.catalog.changes.accept(f.project.id,s.id,{requestId:uid()}),{code:'RENDER_IN_USE'});
 await assert.rejects(f.catalog.fileOperations.preview(f.project.id,{requestId:uid(),kind:'move-videos',sourceIds:[s.id],destinationFolderId:reject.id,unbindAdoptions:true,expectedRolesRevision:1}),{code:'RENDER_IN_USE'});
 await assert.rejects(f.catalog.fileOperations.preview(f.project.id,{requestId:uid(),kind:'move-folder',folderId:a.id,destinationFolderId:reject.id}),{code:'RENDER_IN_USE'});
 await assert.rejects(f.catalog.fileOperations.preview(f.project.id,{requestId:uid(),kind:'delete-folder',folderId:a.id,mode:'trash'}),{code:'RENDER_IN_USE'});
 await assert.rejects(f.catalog.rejectArea.preview(f.project.id,{requestId:uid(),expectedRolesRevision:1,folderId:a.id}),{code:'RENDER_IN_USE'});
 const second=await f.catalog.start(f.project.id,{requestId:uid(),fileName:'same.mp4',folderId:a.id,bytes:f.bytes.length,prompt:{mode:'none'}});const {Readable}=await import('node:stream');const conflict=await f.catalog.upload(f.project.id,second.id,Readable.from([f.bytes]));assert.equal(conflict.status,'duplicate');await assert.rejects(f.catalog.resolve(f.project.id,second.id,{choice:'overwrite',candidateId:conflict.candidates[0].id}),{code:'RENDER_IN_USE'});await fs.access(s.path);
});
test('stale move-to-reject preview rechecks newly linked references before IO',async t=>{
 const f=await fixture(t),s=await imported(f),reject=await folder(f,'废片');rejectRole(f,reject);const plan=await f.catalog.fileOperations.preview(f.project.id,{requestId:uid(),kind:'move-video',sourceId:s.id,destinationFolderId:reject.id,unbindAdoptions:true,expectedRolesRevision:1});await link(f,s);
 await f.catalog.fileOperations.execute(f.project.id,{requestId:plan.requestId,previewHash:plan.previewHash,confirmUnbind:true,confirmedUnbindShotIds:[]});await f.catalog.queue;assert.equal(f.catalog.fileOperations.row(f.project.id,plan.requestId).status,'failed');assert.equal(f.entry.store.source(f.project.id,s.id).path,s.path);await fs.access(s.path);
});
test('same physical file legacy-path and source aliases in other projects are protected',async t=>{
 const f=await fixture(t),s=await imported(f);await legacy(f,s.path);const aliasId=uid(),raw=JSON.parse(s.data_json);f.lib.db.prepare('INSERT INTO storyboard_video_sources VALUES(?,?,?,?,?)').run(aliasId,f.other.id,canonical(raw),1,1);const alias=f.entry.store.source(f.other.id,aliasId);
 assert.throws(()=>f.catalog.assertRenderUnused(alias),e=>e.code==='RENDER_IN_USE'&&e.details.references[0].timelineId===f.timelineId);
 const ordinary=await folder(f,'正常');assert.equal((await operation(f,{kind:'move-video',sourceId:s.id,destinationFolderId:ordinary.id})).status,'ready');
 // A stale legacy path is never auto-migrated to a moved source ID.
 assert.equal((await f.renders.get(f.project.id,f.timelineId,{schema:2})).availability,'missing');
});
test('generic plan/execute protects indexed videos and legacy aliases without weakening managed guard',async t=>{
 const f=await fixture(t),s=await imported(f);await link(f,s);const asset=f.catalog.metadata(f.project.id,s).data.mediaAssetId;
 let rows=await f.lib.plan({action:'rename',ids:[asset],name:'renamed.mp4'});assert.equal(rows[0].code,'RENDER_IN_USE');rows=await f.lib.execute({action:'rename',ids:[asset],name:'renamed.mp4'});assert.equal(rows[0].code,'RENDER_IN_USE');
 await settled(f,await f.renders.remove(f.project.id,f.timelineId,{requestId:uid(),expectedRevision:1}));rows=await f.lib.execute({action:'rename',ids:[asset],name:'renamed.mp4'});assert.equal(rows[0].ok,false);assert.match(rows[0].error,/项目托管视频/);await fs.access(s.path);
});
test('generic late source await + relocate rechecks new legacy binding, leaving ordinary copies allowed',async t=>{
 const f=await fixture(t);const mediaDir=path.join(f.dir,'ordinary');await fs.mkdir(mediaDir);const root=await f.lib.addRoot(mediaDir,'video'),original=path.join(mediaDir,'ordinary.mp4');await fs.copyFile(f.file,original);const st=await fs.stat(original),asset=f.catalog.index(root,original,{hash:'f'.repeat(64),identity:{dev:String(st.dev),ino:String(st.ino),size:st.size,mtimeMs:st.mtimeMs,ctimeMs:st.ctimeMs}});
 const source=f.lib.source.bind(f.lib);let inject=true;f.lib.source=async(...a)=>{const r=await source(...a);if(inject){inject=false;await legacy(f,original);}return r;};const result=await f.lib.execute({action:'rename',ids:[asset],name:'cannot.mp4'});assert.equal(result[0].code,'RENDER_IN_USE');await fs.access(original);
 const copied=path.join(f.dir,'safe-copy.mp4');await fs.copyFile(original,copied);assert.deepEqual(await fs.readFile(copied),await fs.readFile(original));
 f.lib.db.prepare('DELETE FROM project_renders').run();f.lib.source=source;
 let calls=0,guard=f.lib.assertRenderFileMutable.bind(f.lib);f.lib.assertRenderFileMutable=(file,stat,db)=>{calls++;if(calls===2){const p={path:file,offset:0,dev:String(stat.dev),ino:String(stat.ino),size:stat.size,mtime:stat.mtimeMs,updatedAt:Date.now()};f.lib.db.prepare('INSERT INTO project_renders VALUES(?,?,?,?)').run(f.timelineId,f.project.id,JSON.stringify(p),1);}return guard(file,stat,db);};
 await assert.rejects(f.lib.relocate(original,path.join(f.dir,'late-target.mp4')),{code:'RENDER_IN_USE'});await fs.access(original);await assert.rejects(fs.access(path.join(f.dir,'late-target.mp4')));
});
test('undo checks actual current target that became a legacy render',async t=>{
 const f=await fixture(t);const mediaDir=path.join(f.dir,'ordinary');await fs.mkdir(mediaDir);const root=await f.lib.addRoot(mediaDir,'video'),original=path.join(mediaDir,'undo-source.mp4');await fs.copyFile(f.file,original);const st=await fs.stat(original),asset=f.catalog.index(root,original,{hash:'f'.repeat(64),identity:{dev:String(st.dev),ino:String(st.ino),size:st.size,mtimeMs:st.mtimeMs,ctimeMs:st.ctimeMs}});
 const results=await f.lib.execute({action:'rename',ids:[asset],name:'undo-target.mp4'});assert.equal(results[0].ok,true);const target=path.join(mediaDir,'undo-target.mp4');await legacy(f,target);await assert.rejects(f.lib.undo(results[0].operation),{code:'RENDER_IN_USE'});await fs.access(target);await assert.rejects(fs.access(original));
});

test('R1: moved source display snapshot cannot reserve its old path for an unrelated new asset',async t=>{
 const f=await fixture(t),source=await imported(f),oldPath=source.path;await link(f,source);const destination=await folder(f,'moved-render');
 assert.equal((await operation(f,{kind:'move-video',sourceId:source.id,destinationFolderId:destination.id})).status,'ready');
 const moved=f.entry.store.source(f.project.id,source.id);assert.notEqual(moved.path,oldPath);assert.equal((await f.renders.get(f.project.id,f.timelineId,{schema:2})).sync.state,'aligned');
 await fs.writeFile(oldPath,'independent new entity at historical display path');const stat=await fs.stat(oldPath),root=f.lib.roots().find(r=>oldPath.startsWith(r.path+path.sep)),identity={dev:String(stat.dev),ino:String(stat.ino),size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs};
 assert.notEqual(identity.ino,moved.identity.ino);
 const asset=f.catalog.index(root,oldPath,{hash:createHash('sha256').update(await fs.readFile(oldPath)).digest('hex'),identity});assert.notEqual(asset,f.catalog.metadata(f.project.id,moved).data.mediaAssetId);
 const input={action:'rename',ids:[asset],name:'independent-renamed.mp4'},plan=await f.lib.plan(input);assert.equal(plan[0].ok,true,JSON.stringify(plan));
 const result=await f.lib.execute(input,plan);assert.equal(result[0].ok,true,JSON.stringify(result));await fs.access(path.join(path.dirname(oldPath),input.name));await fs.access(moved.path);
 assert.throws(()=>f.catalog.assertRenderUnused(moved),{code:'RENDER_IN_USE'});
 const linked=await f.renders.get(f.project.id,f.timelineId,{schema:2});assert.equal(linked.sourceId,source.id);assert.equal(linked.path,moved.path);assert.equal(linked.sync.state,'aligned');assert.equal(linked.revision,1);
});

test('R2: move and undo late switch cannot classify or notify through the replacement SQLite',async t=>{
 for(const action of ['move','undo']){
  const f=await fixture(t);f.lib.directoryClassification=new DirectoryClassification(f.lib);const dir=path.join(f.dir,'ordinary-r2');await fs.mkdir(dir);const root=await f.lib.addRoot(dir,'video'),file=path.join(dir,'ordinary.mp4');await fs.copyFile(f.file,file);const st=await fs.stat(file),asset=f.catalog.index(root,file,{hash:createHash('sha256').update(await fs.readFile(file)).digest('hex'),identity:{dev:String(st.dev),ino:String(st.ino),size:st.size,mtimeMs:st.mtimeMs,ctimeMs:st.ctimeMs}});
  const destination=path.join(dir,'destination');await fs.mkdir(destination);const input={action:'move',ids:[asset],rootId:root.id,relative:'destination'};let operationId;
  if(action==='undo'){const done=await f.lib.execute(input);assert.equal(done[0].ok,true);operationId=done[0].operation;}
  f.lib.db.prepare("UPDATE assets SET category='stale-projection' WHERE id=?").run(asset);
  const originalDb=f.lib.db,copy=path.join(f.dir,'second-r2.sqlite');await originalDb.backup(copy);const second=new Database(copy),before=second.serialize(),target=action==='move'?path.join(destination,path.basename(file)):file,source=action==='move'?file:path.join(destination,path.basename(file));
  const stat=fs.stat.bind(fs);let switched=false,notifications=0;f.lib.onMetadataChanged=()=>notifications++;
  const mock=t.mock.method(fs,'stat',async(p,...args)=>{const value=await stat(p,...args);if(!switched&&p===target&&!existsSync(source)){switched=true;f.lib.db=second;}return value;});
  let result,error;
  try{
   if(action==='move')result=(await f.lib.execute(input))[0];else try{await f.lib.undo(operationId);}catch(e){error=e;}
   assert.equal(switched,true);assert.deepEqual(second.serialize(),before,'replacement library changed');assert.equal(notifications,0);
   if(action==='move'){assert.equal(result.ok,false);assert.equal(result.code,'LOCAL_INSTANCE_CHANGED');operationId=result.operation;assert.equal(result.details.fileChanged,true);}else{assert.equal(error.code,'LOCAL_INSTANCE_CHANGED');assert.equal(error.details.fileChanged,true);}
   const receipt=originalDb.prepare('SELECT * FROM operations WHERE id=?').get(operationId);assert.equal(receipt.status,'interrupted');assert.match(receipt.error,/文件已移动/);assert.equal(receipt.undone,0);await fs.access(target);await assert.rejects(fs.access(source));
  }finally{mock.mock.restore();f.lib.db=originalDb;second.close();}
 }
});
