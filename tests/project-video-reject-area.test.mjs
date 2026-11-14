import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import {randomUUID} from 'node:crypto';
import {canonical} from '../server/project-assets/model.mjs';
import {ProjectVideoRejectArea} from '../server/project-videos/reject-area.mjs';
import {projectVideoRouter} from '../server/project-videos/router.mjs';
import {fixture,imported,initialize,bind} from './helpers/project-video-desktop-fixture.mjs';

const folder=(f,name,parentId='root')=>f.catalog.folders.create(f.project.id,{requestId:randomUUID(),name,parentId});
const preview=(f,folderId,extra={})=>f.catalog.rejectArea.preview(f.project.id,{requestId:randomUUID(),expectedRolesRevision:f.catalog.folders.roleState(f.project.id).revision,folderId,...extra});
const createPreview=(f,name='废片')=>f.catalog.rejectArea.preview(f.project.id,{requestId:randomUUID(),expectedRolesRevision:f.catalog.folders.roleState(f.project.id).revision,create:{parentId:'root',name}});
const confirmation=plan=>({requestId:plan.requestId,previewHash:plan.previewHash,confirmRoleChange:true,confirmUnbind:true,confirmedUnbindShotIds:plan.affectedShots.map(s=>s.id)});
async function execute(f,plan,extra={}){
  await f.catalog.rejectArea.execute(f.project.id,{...confirmation(plan),...extra});
  await f.catalog.rejectArea.active.get(plan.requestId);
  return f.catalog.rejectArea.dto(plan.requestId,f.catalog.rejectArea.row(f.project.id,plan.requestId));
}
const setRole=async(f,id)=>execute(f,await preview(f,id));
const code=expected=>e=>e.code===expected;

test('unconfigured reads create nothing; subtree count is metadata only and every copy counts',async t=>{
  const f=await fixture(t),id=f.project.id,root=await f.catalog.folders.rootPath(id);
  const empty=await f.catalog.list(id,{folderId:'reject'});
  assert.deepEqual(empty.folderRoles,{revision:0,rejectFolderId:null,rejectVideoCount:0,needsReview:false,finalFolderId:null,finalState:'not_created',finalErrorCode:null});assert.deepEqual(empty.videos,[]);
  await assert.rejects(fs.access(root));
  const a=await folder(f,'废片'),b=await folder(f,'子层',a.id),ordinary=await folder(f,'其他');
  const first=await imported(f,'copy1.mp4',a.id),second=await imported(f,'copy2.mp4',b.id),third=await imported(f,'normal.mp4',ordinary.id);
  await setRole(f,a.id);
  const lstat=fs.lstat,hash=f.catalog.hash,probe=f.entry.media.probe;
  fs.lstat=()=>{throw Error('roleState must not use FS');};f.catalog.hash=()=>{throw Error('no hash');};f.entry.media.probe=()=>{throw Error('no probe');};
  try{assert.deepEqual(f.catalog.folders.roleState(id),{revision:1,rejectFolderId:a.id,rejectVideoCount:2,needsReview:false,finalFolderId:null,finalState:'not_created',finalErrorCode:null});assert.equal(f.catalog.folders.inRejectArea(id,b.id),true);assert.equal(f.catalog.folders.inRejectArea(id,ordinary.id),false);}finally{fs.lstat=lstat;f.catalog.hash=hash;f.entry.media.probe=probe;}
  const all=await f.catalog.list(id,{folderId:'all'});assert.deepEqual(all.videos.map(s=>s.id),[third.id]);
  assert.equal(all.folders.length,3);assert.equal(all.folders.find(s=>s.id===a.id).role,'reject');assert.equal(all.folders.find(s=>s.id===b.id).parentId,a.id);
  const included=await f.catalog.list(id,{folderId:'all',includeRejected:true});assert.equal(included.videos.length,3);assert.equal(included.videos.find(s=>s.id===second.id).inRejectArea,true);
  const rejected=await f.catalog.list(id,{folderId:'reject'});assert.deepEqual(new Set(rejected.videos.map(s=>s.id)),new Set([first.id,second.id]));
  const meta=f.catalog.metadata(id,second);f.entry.store.tx(()=>f.catalog.record(id,second.id,{...meta.data,removedAt:Date.now()},meta.row.revision+1));assert.equal(f.catalog.folders.roleState(id).rejectVideoCount,1);
});

test('create preview freezes an ID without creating a root; concurrent replay creates once',async t=>{
  const f=await fixture(t),id=f.project.id,plan=await createPreview(f),root=await f.catalog.folders.rootPath(id);
  assert.equal(plan.roleChange.willCreate,true);assert.ok(plan.roleChange.afterFolderId);await assert.rejects(fs.access(root));
  const raw={requestId:plan.requestId,expectedRolesRevision:0,create:{parentId:'root',name:'废片'}};
  assert.deepEqual(await f.catalog.rejectArea.preview(id,raw),plan);
  const mkdir=fs.mkdir;let calls=0;fs.mkdir=async(...args)=>{if(args[0]===path.join(root,'废片'))calls++;return mkdir(...args);};
  let done;try{await Promise.all([f.catalog.rejectArea.execute(id,confirmation(plan)),f.catalog.rejectArea.execute(id,confirmation(plan))]);await f.catalog.rejectArea.active.get(plan.requestId);done=f.catalog.rejectArea.dto(plan.requestId,f.catalog.rejectArea.row(id,plan.requestId));}finally{fs.mkdir=mkdir;}
  assert.equal(done.status,'ready',done.error);assert.equal(done.folderRoles.rejectFolderId,plan.roleChange.afterFolderId);assert.equal(done.canRecover,false);assert.equal(calls,1);
  assert.equal((await f.catalog.rejectArea.execute(id,confirmation(plan))).status,'ready');assert.equal(f.catalog.folders.rows(id).length,1);
  const restart=new ProjectVideoRejectArea(f.catalog);assert.equal((await restart.execute(id,confirmation(plan))).status,'ready');
  await assert.rejects(f.catalog.rejectArea.preview(id,{...raw,create:{parentId:'root',name:'另一个'}}),code('REQUEST_ID_CONFLICT'));
  await assert.rejects(f.catalog.rejectArea.execute(id,{...confirmation(plan),previewHash:'wrong'}),code('PREVIEW_REQUIRED'));
});

test('existing adopted subtree requires the exact shot union; whole mixed take is unbound without retiring sources',async t=>{
  const f=await fixture(t);initialize(f);const id=f.project.id,a=await folder(f,'现有目录'),b=await folder(f,'子目录',a.id),one=await imported(f,'one.mp4',a.id),two=await imported(f,'two.mp4',b.id),outside=await imported(f,'outside.mp4');
  await bind(f,one,[0,1]);await bind(f,two,[2]);
  const state=f.entry.store.baseState(id),takeId=state.plan.adopted[state.shots[0].id];
  const mixed={segments:[{sourceId:one.id,inMs:0,outMs:500},{sourceId:outside.id,inMs:0,outMs:500}],alignment:'manual',timingHash:state.timingHash};
  f.lib.db.prepare('UPDATE storyboard_video_takes SET data_json=? WHERE id=?').run(canonical(mixed),takeId);
  const beforeSources=f.entry.store.sources(id),beforeRecords=f.lib.db.prepare('SELECT * FROM project_video_records ORDER BY id').all(),beforeTakes=f.lib.db.prepare('SELECT * FROM storyboard_video_takes ORDER BY id').all(),document=f.storyboards.head(id);
  const plan=await preview(f,a.id);assert.equal(plan.affectedShots.length,3);assert.deepEqual(new Set(plan.affectedShots.flatMap(s=>s.sourceIds)),new Set([one.id,two.id]));
  for(const extra of [{confirmRoleChange:false},{confirmUnbind:false},{confirmedUnbindShotIds:[]},{confirmedUnbindShotIds:[...plan.affectedShots.map(s=>s.id),'extra']},{confirmedUnbindShotIds:[plan.affectedShots[0].id,plan.affectedShots[0].id,plan.affectedShots[1].id]}])await assert.rejects(f.catalog.rejectArea.execute(id,{...confirmation(plan),...extra}),e=>['ROLE_CHANGE_CONFIRMATION_REQUIRED','UNBIND_CONFIRMATION_REQUIRED'].includes(e.code));
  assert.equal(f.catalog.rejectArea.row(id,plan.requestId).status,'preview');assert.equal(f.catalog.folders.roleState(id).rejectFolderId,null);
  const done=await execute(f,plan);assert.equal(done.status,'ready',done.error);assert.deepEqual(new Set(done.unboundShotIds),new Set(plan.affectedShots.map(s=>s.id)));
  assert.deepEqual(f.entry.store.baseState(id).plan.adopted,{});assert.deepEqual(f.entry.store.sources(id),beforeSources);assert.deepEqual(f.lib.db.prepare('SELECT * FROM project_video_records ORDER BY id').all(),beforeRecords);assert.deepEqual(f.lib.db.prepare('SELECT * FROM storyboard_video_takes ORDER BY id').all(),beforeTakes);assert.deepEqual(f.storyboards.head(id),document);
  for(const source of [one,two,outside]){assert.equal(f.catalog.isManaged(id,f.entry.store.source(id,source.id)),true);await fs.access(source.path);}
});

test('switch and cancellation leave old directories, files and adoptions untouched',async t=>{
  const f=await fixture(t);initialize(f);const a=await folder(f,'甲'),b=await folder(f,'乙'),one=await imported(f,'one.mp4',a.id),two=await imported(f,'two.mp4',b.id);
  await setRole(f,a.id);await bind(f,one,[0]);await bind(f,two,[1]);
  const plan=await preview(f,b.id);assert.deepEqual(plan.roleChange,{beforeFolderId:a.id,afterFolderId:b.id,willCreate:false});assert.equal(plan.affectedShots.length,1);
  assert.equal((await execute(f,plan)).status,'ready');assert.equal(Object.keys(f.entry.store.baseState(f.project.id).plan.adopted).length,1);
  const before=f.entry.store.baseState(f.project.id).plan,cancel=await preview(f,null);assert.deepEqual(cancel.affectedShots,[]);const cancelled=await execute(f,cancel);assert.equal(cancelled.status,'ready');assert.equal(cancelled.folderId,null);assert.deepEqual(f.entry.store.baseState(f.project.id).plan,before);
  await fs.access(one.path);await fs.access(two.path);assert.equal((await f.catalog.list(f.project.id,{folderId:'all'})).videos.length,2);
});

test('settings row revision is the CAS authority, including old rows and upgrade preservation',async t=>{
  const f=await fixture(t),id=f.project.id,a=await folder(f,'角色');
  const old=await preview(f,a.id),now=Date.now();f.lib.db.prepare('INSERT INTO project_video_settings VALUES(?,?,?,?,?,?)').run(id,id,canonical({upgradeCompleted:false}),7,now,now);
  assert.equal(f.catalog.folders.roleState(id).revision,7);assert.equal((await execute(f,old)).errorCode,'FOLDER_ROLES_CONFLICT');
  await assert.rejects(preview(f,a.id,{expectedRolesRevision:0}),code('FOLDER_ROLES_CONFLICT'));
  const selected=await setRole(f,a.id);assert.equal(selected.folderRoles.revision,8);
  const stale=await preview(f,null);f.entry.store.tx(()=>f.catalog.folders.completeUpgrade(id));assert.deepEqual(f.catalog.folders.settings(id),{upgradeCompleted:true,rejectFolderId:a.id,finalFolderId:null});assert.equal(f.catalog.folders.roleState(id).revision,9);assert.equal((await execute(f,stale)).errorCode,'FOLDER_ROLES_CONFLICT');
  assert.throws(()=>f.catalog.folders.writeSettings(id,{upgradeCompleted:true,rejectFolderId:null},8),code('FOLDER_ROLES_CONFLICT'));
});

test('late metadata/source/adoption/permission changes fail before role and unbind commit',async t=>{
  const f=await fixture(t);initialize(f);const id=f.project.id,a=await folder(f,'待设置'),one=await imported(f,'one.mp4',a.id);await bind(f,one,[0]);
  let plan=await preview(f,a.id);const m=f.catalog.metadata(id,one);f.entry.store.tx(()=>f.catalog.record(id,one.id,{...m.data,notes:'later edit'},m.row.revision+1));assert.equal((await execute(f,plan)).errorCode,'VIDEO_CONFLICT');
  plan=await preview(f,a.id);await bind(f,one,[1]);assert.equal((await execute(f,plan)).errorCode,'ADOPTION_CHANGED');
  plan=await preview(f,a.id);f.lib.db.prepare('DELETE FROM storyboard_video_approvals WHERE id=?').run(one.id);assert.equal((await execute(f,plan)).errorCode,'VIDEO_CONFLICT');
  assert.equal(f.catalog.folders.roleState(id).rejectFolderId,null);assert.equal(Object.keys(f.entry.store.baseState(id).plan.adopted).length,2);
});

test('directory identity replacement is visible for role reads and rejected at execution; no same-name adoption',async t=>{
  const f=await fixture(t),id=f.project.id,a=await folder(f,'废片'),plan=await preview(f,a.id);
  await fs.rename(a.path,a.path+'-original');await fs.mkdir(a.path);assert.equal((await execute(f,plan)).errorCode,'TARGET_CHANGED');
  await fs.rmdir(a.path);await fs.rename(a.path+'-original',a.path);await setRole(f,a.id);
  await fs.rename(a.path,a.path+'-saved');await fs.mkdir(a.path);
  const list=await f.catalog.list(id,{folderId:'all'});assert.equal(list.folderRoles.rejectFolderId,a.id);assert.equal(list.folderRoles.needsReview,true);assert.equal(list.folderRoles.errorCode,'REJECT_FOLDER_CHANGED');
  await f.catalog.folders.refresh(id,'root');assert.equal(f.catalog.folders.row(id,a.id).relativePath,'废片-saved');assert.notEqual(f.catalog.folders.rows(id).find(r=>r.relativePath==='废片')?.id,a.id);
  assert.equal((await setRole(f,null)).status,'ready');await fs.access(a.path+'-saved');await fs.access(a.path);
});

test('missing role metadata is visible and cancellable; missing filesystem does not recreate it',async t=>{
  const f=await fixture(t),id=f.project.id,a=await folder(f,'角色');await setRole(f,a.id);await fs.rmdir(a.path);
  let list=await f.catalog.list(id,{folderId:'reject'});assert.equal(list.folderRoles.needsReview,true);assert.equal(list.folderRoles.errorCode,'REJECT_FOLDER_MISSING');await assert.rejects(fs.access(a.path));
  f.lib.db.prepare('DELETE FROM project_video_folders WHERE id=?').run(a.id);list=await f.catalog.list(id,{folderId:'all'});assert.equal(list.folderRoles.rejectFolderId,a.id);assert.equal(list.folderRoles.needsReview,true);assert.equal(f.catalog.folders.roleState(id).needsReview,true);
  assert.equal((await setRole(f,null)).status,'ready');assert.equal(f.catalog.folders.roleState(id).rejectFolderId,null);
});

test('broken role with videos still returns reject/all review state and never probes replacements',async t=>{
  const f=await fixture(t),id=f.project.id,a=await folder(f,'失效收纳处'),child=await folder(f,'子目录',a.id),source=await imported(f,'owned.mp4',child.id);await setRole(f,a.id);
  await fs.rename(a.path,a.path+'-saved');await fs.mkdir(a.path);
  let list=await f.catalog.list(id,{folderId:'reject'});assert.equal(list.folderRoles.needsReview,true);assert.equal(list.folderRoles.rejectVideoCount,1);assert.equal(list.videos[0].id,source.id);assert.equal(list.videos[0].status,'changed');
  assert.deepEqual((await f.catalog.list(id,{folderId:'all'})).videos,[]);
  f.lib.db.prepare('DELETE FROM project_video_folders WHERE id=?').run(a.id);
  assert.equal(f.catalog.folders.inRejectArea(id,child.id),true);list=await f.catalog.list(id,{folderId:'reject'});assert.equal(list.folderRoles.errorCode,'REJECT_FOLDER_MISSING');assert.equal(list.videos[0].status,'missing');assert.equal(list.folderRoles.rejectVideoCount,1);
  assert.deepEqual((await f.catalog.list(id,{folderId:'all'})).videos,[]);
});

test('role follows folder IDs through rename/move; deletion clears on any old ancestor atomically',async t=>{
  const f=await fixture(t),id=f.project.id,a=await folder(f,'祖先'),b=await folder(f,'收纳根',a.id),c=await folder(f,'目标');await setRole(f,b.id);
  // Exercise the synchronous callback in exactly the transaction shape used by
  // file operations, including rollback and contents-to-root ancestor deletion.
  assert.throws(()=>f.entry.store.tx(()=>{f.catalog.folders.clearRemovedRole(id,[a.id]);assert.equal(f.catalog.folders.roleState(id).rejectFolderId,null);throw Error('rollback');}),/rollback/);
  assert.equal(f.catalog.folders.roleState(id).rejectFolderId,b.id);assert.equal(f.catalog.folders.roleState(id).revision,1);
  f.entry.store.tx(()=>f.catalog.folders.clearRemovedRole(id,[c.id]));assert.equal(f.catalog.folders.roleState(id).revision,1);
  await fs.rename(a.path,path.join(c.path,'祖先'));
  f.entry.store.tx(()=>{const parent=f.catalog.folders.row(id,a.id),role=f.catalog.folders.row(id,b.id);f.catalog.folders.write(id,a.id,f.catalog.folders.data(parent,{parentId:c.id,relativePath:'目标/祖先'}));f.catalog.folders.write(id,b.id,f.catalog.folders.data(role,{relativePath:'目标/祖先/收纳根'}));});
  assert.equal(f.catalog.folders.roleState(id).rejectFolderId,b.id);assert.equal((await f.catalog.list(id,{folderId:'all'})).folderRoles.needsReview,false);
  f.entry.store.tx(()=>{f.catalog.folders.clearRemovedRole(id,[a.id]);const row=f.catalog.folders.row(id,a.id);f.catalog.folders.write(id,a.id,f.catalog.folders.data(row,{removedAt:Date.now()}));const role=f.catalog.folders.row(id,b.id);f.catalog.folders.write(id,b.id,f.catalog.folders.data(role,{parentId:'root',relativePath:role.name}));});
  assert.equal(f.catalog.folders.roleState(id).rejectFolderId,null);assert.equal(f.catalog.folders.roleState(id).revision,2);
  f.entry.store.tx(()=>{const row=f.lib.db.prepare('SELECT * FROM project_video_folders WHERE id=?').get(a.id),d=JSON.parse(row.data_json);f.catalog.folders.write(id,a.id,{...d,removedAt:0});});assert.equal(f.catalog.folders.roleState(id).rejectFolderId,null);
});

test('backup validates role identity and preserves settings on restore; legacy tables/rows remain accepted',async t=>{
  const f=await fixture(t),id=f.project.id,a=await folder(f,'备份角色');await setRole(f,a.id);f.entry.store.tx(()=>f.catalog.folders.completeUpgrade(id));
  const backup=f.storyboards.backup(),input=backup.video_preview;
  f.storyboards.validateBackup(backup);assert.equal(JSON.parse(input.project_video_settings[0].data_json).rejectFolderId,a.id);
  const restored=await fixture(t);restored.projects.save(restored.project.id,{name:'恢复目标-'+randomUUID()});restored.projects.save(restored.other.id,{name:'恢复目标其他-'+randomUUID()});assert.equal((await restored.storyboards.restore(backup)).restored,true);
  assert.deepEqual(restored.lib.db.prepare('SELECT * FROM project_video_settings WHERE id=?').get(id),input.project_video_settings[0]);
  assert.equal(restored.catalog.folders.roleState(id).rejectFolderId,a.id);assert.equal(restored.catalog.folders.settings(id).upgradeCompleted,true);
  for(const mutate of [
    d=>{d.project_video_settings[0].data_json=canonical({upgradeCompleted:true,rejectFolderId:randomUUID()});},
    d=>{d.project_video_folders[0].project_id=f.other.id;},
    d=>{d.project_video_folders[0].data_json=canonical({...JSON.parse(d.project_video_folders[0].data_json),removedAt:Date.now()});},
    d=>{d.project_video_settings[0].id=randomUUID();},
    d=>{d.project_video_settings[0].revision=0;},
    d=>{d.project_video_settings[0].data_json=canonical({upgradeCompleted:true,rejectFolderId:'root'});},
    d=>{d.project_video_settings.push({...d.project_video_settings[0]});},
    d=>{d.project_video_settings[0].data_json=canonical({upgradeCompleted:true,rejectFolderId:a.id,role:'reject'});}
  ]){const bad=structuredClone(input);mutate(bad);assert.throws(()=>f.entry.store.validateBackup(bad,[],[f.project,f.other]),code('VIDEO_BACKUP_INVALID'));}
  const old=structuredClone(input);old.project_video_settings[0].data_json=canonical({upgradeCompleted:false});assert.equal(f.entry.store.validateBackup(old,[],[f.project,f.other]).project_video_settings.length,1);
  delete old.project_video_folders;delete old.project_video_settings;assert.deepEqual(f.entry.store.validateBackup(old,[],[f.project,f.other]).project_video_settings,[]);
});

test('same-name/create conflicts and invalid/cross-project inputs never claim a role',async t=>{
  const f=await fixture(t),id=f.project.id,a=await folder(f,'废片');
  await assert.rejects(createPreview(f),code('FOLDER_EXISTS'));
  const foreign=await f.catalog.folders.create(f.other.id,{requestId:randomUUID(),name:'外项目'});await assert.rejects(preview(f,foreign.id),code('FOLDER_NOT_FOUND'));
  for(const input of [{folderId:'root'},{folderId:'all'},{folderId:'reject'},{folderId:null,create:{parentId:'root',name:'新建'}},{create:{parentId:a.id,name:'新建'}}])await assert.rejects(f.catalog.rejectArea.preview(id,{requestId:randomUUID(),expectedRolesRevision:0,...input}),code('INVALID_REJECT_AREA'));
  assert.equal(f.catalog.folders.roleState(id).rejectFolderId,null);assert.equal(f.catalog.folders.rows(id).length,1);
});

test('mkdir failure, metadata rollback and unknown creation each preserve truthful non-retriable receipts',async t=>{
  const f=await fixture(t),id=f.project.id,old=await folder(f,'旧角色');await setRole(f,old.id);
  let plan=await createPreview(f,'mkdir-fails');const mkdir=fs.mkdir;
  fs.mkdir=async(...args)=>{if(path.basename(args[0])==='mkdir-fails')throw Object.assign(Error('denied'),{code:'EACCES'});return mkdir(...args);};
  try{assert.equal((await execute(f,plan)).status,'failed');}finally{fs.mkdir=mkdir;}
  assert.equal((await execute(f,plan)).status,'failed');
  plan=await createPreview(f,'db-fails');const write=f.catalog.folders.write;
  f.catalog.folders.write=()=>{throw Error('fixture metadata failure');};try{assert.equal((await execute(f,plan)).status,'failed');}finally{f.catalog.folders.write=write;}
  await assert.rejects(fs.access(path.join(await f.catalog.folders.rootPath(id),'db-fails')));assert.equal(f.catalog.folders.roleState(id).rejectFolderId,old.id);
  plan=await createPreview(f,'unknown-create');fs.mkdir=async(...args)=>{const result=await mkdir(...args);if(path.basename(args[0])==='unknown-create')throw Error('lost mkdir response');return result;};
  try{assert.equal((await execute(f,plan)).status,'unknown');}finally{fs.mkdir=mkdir;}
  const unknown=await execute(f,plan);assert.equal(unknown.status,'unknown');assert.equal(unknown.canRecover,false);assert.equal(f.catalog.folders.rows(id).length,1);assert.equal(f.catalog.folders.roleState(id).rejectFolderId,old.id);await fs.access(old.path);
});

test('failure after detach or at durable ready write rolls back settings, adoptions and directory registration',async t=>{
  const f=await fixture(t);initialize(f);const id=f.project.id,a=await folder(f,'采用目录'),source=await imported(f,'adopted.mp4',a.id);await bind(f,source,[0]);const before=f.entry.store.baseState(id).plan;
  const plan=await preview(f,a.id),write=f.catalog.folders.writeSettings;f.catalog.folders.writeSettings=()=>{throw Error('settings fail after detach');};try{assert.equal((await execute(f,plan)).status,'failed');}finally{f.catalog.folders.writeSettings=write;}
  assert.deepEqual(f.entry.store.baseState(id).plan,before);assert.equal(f.catalog.folders.roleState(id).revision,0);assert.equal(f.catalog.metadata(id,source).data.removedAt,0);
  const create=await createPreview(f,'ready-save-fails'),save=f.catalog.rejectArea.save;f.catalog.rejectArea.save=function(...args){if(args[2].status==='ready')throw Error('ready persist failed');return save.apply(this,args);};
  try{assert.equal((await execute(f,create)).status,'failed');}finally{f.catalog.rejectArea.save=save;}
  assert.equal(f.catalog.folders.rows(id).length,1);assert.equal(f.catalog.folders.roleState(id).revision,0);await assert.rejects(fs.access(path.join(await f.catalog.folders.rootPath(id),'ready-save-fails')));
});

test('late execute IO rechecks folder identity, role revision and permissions before metadata commit',async t=>{
  const f=await fixture(t);initialize(f);const id=f.project.id,a=await folder(f,'执行期核对'),source=await imported(f,'owned.mp4',a.id);await bind(f,source,[0]);
  const verify=f.entry.media.verify;let plan=await preview(f,a.id),calls=0;
  f.entry.media.verify=async function(...args){const result=await verify.apply(this,args);if(++calls===2){await fs.rename(a.path,a.path+'-saved');await fs.mkdir(a.path);}return result;};
  try{assert.equal((await execute(f,plan)).errorCode,'TARGET_CHANGED');}finally{f.entry.media.verify=verify;}
  await fs.rmdir(a.path);await fs.rename(a.path+'-saved',a.path);plan=await preview(f,a.id);calls=0;
  f.entry.media.verify=async function(...args){const result=await verify.apply(this,args);if(++calls===2)f.entry.store.tx(()=>f.catalog.folders.completeUpgrade(id));return result;};
  try{assert.equal((await execute(f,plan)).errorCode,'FOLDER_ROLES_CONFLICT');}finally{f.entry.media.verify=verify;}
  plan=await preview(f,a.id);const env=process.env.MEDIA_READONLY_FILES;calls=0;
  f.entry.media.verify=async function(...args){const result=await verify.apply(this,args);if(++calls===2)process.env.MEDIA_READONLY_FILES='1';return result;};
  try{assert.equal((await execute(f,plan)).errorCode,'READONLY_FILES');}finally{f.entry.media.verify=verify;if(env===undefined)delete process.env.MEDIA_READONLY_FILES;else process.env.MEDIA_READONLY_FILES=env;}
  assert.equal(f.catalog.folders.roleState(id).rejectFolderId,null);assert.equal(Object.keys(f.entry.store.baseState(id).plan.adopted).length,1);
});

test('lost commit acknowledgement reads durable ready receipt without removing the registered folder',async t=>{
  const f=await fixture(t),id=f.project.id,plan=await createPreview(f),tx=f.entry.store.tx;
  f.entry.store.tx=function(fn){const result=tx.call(this,fn);throw Error('fixture lost commit acknowledgement');};
  let done;try{done=await execute(f,plan);}finally{f.entry.store.tx=tx;}
  assert.equal(done.status,'ready',done.error);assert.equal(done.folderId,plan.roleChange.afterFolderId);assert.equal(f.catalog.folders.rows(id).length,1);await fs.access(f.catalog.folders.dto(f.catalog.folders.row(id,done.folderId),await f.catalog.folders.rootPath(id)).path);
});

test('failed journal finalization leaves unknown on read and never issues another mkdir',async t=>{
  const f=await fixture(t),id=f.project.id,plan=await createPreview(f),save=f.catalog.rejectArea.save,write=f.catalog.folders.write;
  f.catalog.folders.write=()=>{throw Error('owned metadata failure');};f.catalog.rejectArea.save=function(...args){if(args[2].status==='failed')throw Error('journal unavailable');return save.apply(this,args);};
  try{await f.catalog.rejectArea.execute(id,confirmation(plan));await assert.rejects(f.catalog.rejectArea.active.get(plan.requestId),/journal unavailable/);}finally{f.catalog.folders.write=write;f.catalog.rejectArea.save=save;}
  const done=await execute(f,plan);assert.equal(done.status,'unknown');assert.equal(done.canRecover,false);assert.equal(f.catalog.folders.rows(id).length,0);await assert.rejects(fs.access(path.join(await f.catalog.folders.rootPath(id),'废片')));
});

test('interrupted running journal is unknown and replay cannot create anything',async t=>{
  const f=await fixture(t),id=f.project.id,plan=await createPreview(f),s=f.catalog.rejectArea.row(id,plan.requestId);s.status='running';s.instance='previous-instance';f.catalog.rejectArea.save(id,plan.requestId,s);
  const restart=new ProjectVideoRejectArea(f.catalog),done=await restart.execute(id,confirmation(plan));assert.equal(done.status,'unknown');assert.equal(done.canRecover,false);assert.equal(f.catalog.folders.rows(id).length,0);await assert.rejects(fs.access(await f.catalog.folders.rootPath(id)));
});

test('write guards retain readonly, generation lock and shutdown restrictions',async t=>{
  const f=await fixture(t),id=f.project.id,a=await folder(f,'目标'),plan=await preview(f,a.id),env=process.env.MEDIA_READONLY_FILES;
  process.env.MEDIA_READONLY_FILES='1';try{await assert.rejects(f.catalog.rejectArea.execute(id,confirmation(plan)),code('READONLY_FILES'));await assert.rejects(preview(f,a.id),code('READONLY_FILES'));}finally{if(env===undefined)delete process.env.MEDIA_READONLY_FILES;else process.env.MEDIA_READONLY_FILES=env;}
  const locks=f.storyboards.generationLocks;f.storyboards.generationLocks={assertWritable(){throw Object.assign(Error('generation locked'),{code:'FIXTURE_LOCKED'});}};try{await assert.rejects(f.catalog.rejectArea.execute(id,confirmation(plan)),code('FIXTURE_LOCKED'));}finally{f.storyboards.generationLocks=locks;}
  f.entry.media.closing=true;try{await assert.rejects(f.catalog.rejectArea.execute(id,confirmation(plan)),code('VIDEO_BUSY'));}finally{f.entry.media.closing=false;}
  assert.equal(f.catalog.folders.roleState(id).revision,0);
});

test('HTTP routes use reject DTO/query and includeRejected, and reject generic execute/recovery',async t=>{
  const f=await fixture(t),app=express();app.use(projectVideoRouter(f.catalog));const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}/projects/${f.project.id}`,post=(url,body)=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const response=await post('/folders/reject/preview',{requestId:randomUUID(),expectedRolesRevision:0,create:{parentId:'root',name:'废片'}});assert.equal(response.status,200);const plan=await response.json();
  const fileRow=f.catalog.fileOperations.row;f.catalog.fileOperations.row=function(...args){const s=fileRow.apply(this,args);if(s.kind==='set-reject-area')throw Object.assign(Error('file operation namespace rejects roles'),{code:'REQUEST_ID_CONFLICT',status:409});return s;};
  const wrong=await post('/operations',confirmation(plan));assert.equal(wrong.status,409);
  assert.equal((await post('/folders/reject',confirmation(plan))).status,200);await f.catalog.rejectArea.active.get(plan.requestId);
  const done=await(await fetch(base+'/operations/'+plan.requestId)).json();assert.equal(done.status,'ready');assert.equal(done.folderRoles.rejectFolderId,plan.roleChange.afterFolderId);assert.equal(done.canRecover,false);
  const recovery=await post('/operations/'+plan.requestId+'/recover',{action:'rollback'});assert.equal(recovery.status,409);assert.equal((await recovery.json()).code,'INVALID_RECOVERY');
  const source=await imported(f,'rejected.mp4',done.folderRoles.rejectFolderId),normal=await(await fetch(base+'?folderId=all')).json(),included=await(await fetch(base+'?folderId=all&includeRejected=true')).json(),rejected=await(await fetch(base+'?folderId=reject')).json();
  assert.deepEqual(normal.videos,[]);assert.deepEqual(included.videos.map(v=>v.id),[source.id]);assert.deepEqual(rejected.videos.map(v=>v.id),[source.id]);
});
