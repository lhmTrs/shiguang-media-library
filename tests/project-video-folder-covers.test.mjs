import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {summarizeVideoFolders} from '../server/project-videos/folder-summaries.mjs';
import {fixture,imported} from './helpers/project-video-desktop-fixture.mjs';
import {canonical} from '../server/project-assets/model.mjs';
const folder=(f,name,parentId='root')=>f.catalog.folders.create(f.project.id,{requestId:randomUUID(),name,parentId});
const entry=(id,folderId='a',created_at=1,extra={})=>({source:{id,created_at},folderId,data:{removedAt:0,mediaAssetId:'asset-'+id},...extra});
const summarize=(rows,entries,reject=null,managed=()=>true)=>summarizeVideoFolders(rows,entries,reject,managed);

test('0/1/2/3/>3 covers, stable import time and descending ID ties; source IDs deduplicate',()=>{
 const rows=[{id:'a',parentId:'root'}];
 for(let n=0;n<=5;n++){
  const items=Array.from({length:n},(_,i)=>entry(String(i)));
  const s=summarize(rows,items).get('a');assert.equal(s.videoCount,n);assert.equal(s.covers.length,Math.min(n,3));
  assert.deepEqual(s.covers.map(c=>c.videoId),items.map(x=>x.source.id).reverse().slice(0,3));
 }
 const items=[entry('old','a',1),entry('new','a',2),entry('old','a',1)];items[0].source.updated_at=9999;
 assert.deepEqual(summarize(rows,items).get('a'),{videoCount:2,covers:[{videoId:'new',thumbnailUrl:'/api/media/asset-new/thumb'},{videoId:'old',thumbnailUrl:'/api/media/asset-old/thumb'}]});
});

test('nested reject subtree is excluded only from ordinary ancestors; unassigned/root/removed sources stay separate',()=>{
 const rows=[{id:'a',parentId:'root'},{id:'b',parentId:'a'},{id:'r',parentId:'a'},{id:'rchild',parentId:'r'},{id:'empty',parentId:'root'}];
 const items=[entry('one','b'),entry('copy','b'),entry('reject','r'),entry('reject-child','rchild'),entry('root','root'),entry('legacy',null),entry('removed','b',4,{data:{removedAt:10,mediaAssetId:'removed'}})];
 const s=summarize(rows,items,'r');assert.equal(s.get('a').videoCount,2);assert.equal(s.get('b').videoCount,2);assert.equal(s.get('r').videoCount,2);assert.equal(s.get('rchild').videoCount,1);assert.equal(s.get('empty').videoCount,0);
 assert.deepEqual(s.get('a').covers.map(c=>c.videoId),['one','copy']);assert.deepEqual(s.get('r').covers.map(c=>c.videoId),['reject-child','reject']);
});

test('counts include unmanaged records; only eligible candidates become covers, checked once across ancestors',()=>{
 const rows=[{id:'a',parentId:'root'},{id:'b',parentId:'a'}],calls=[];
 const items=[entry('unmanaged','b',5),entry('ok','b',4),entry('unapproved','b',3)];
 const s=summarize(rows,items,null,x=>{calls.push(x.source.id);return x.source.id==='ok';});
 assert.equal(s.get('a').videoCount,3);assert.equal(s.get('b').videoCount,3);assert.equal(s.get('a').covers.length,1);assert.deepEqual(calls,['unmanaged','ok','unapproved']);
 assert.deepEqual(summarize(rows,items,null,()=>false).get('a'),{videoCount:3,covers:[]});
});

function setData(f,source,patch){const meta=f.catalog.metadata(f.project.id,source);f.lib.db.prepare('UPDATE project_video_records SET data_json=? WHERE id=?').run(canonical({...meta.data,...patch}),source.id);}
const projectFolders=list=>list.folders.map(({id,videoCount,covers})=>({id,videoCount,covers}));

test('real catalog: view-independent subtree summaries, exact managed proof, stable ordering and zero new status/verify IO',async t=>{
 const f=await fixture(t),a=await folder(f,'normal'),b=await folder(f,'child',a.id),r=await folder(f,'reject',a.id),rc=await folder(f,'reject-child',r.id),empty=await folder(f,'empty');
 const settings=f.catalog.folders.settingsRow(f.project.id);f.catalog.folders.writeSettings(f.project.id,{...f.catalog.folders.settingsData(settings),rejectFolderId:r.id},settings?.revision||0);
 const sources=[];for(let i=0;i<5;i++)sources.push(await imported(f,'clip-'+i+'.mp4',i===0?a.id:b.id));
 const rejected=await imported(f,'reject.mp4',rc.id),root=await imported(f,'root.mp4');
 // Import timestamp ties must use ID, never mutable metadata timestamps.
 for(const source of sources)f.lib.db.prepare('UPDATE storyboard_video_sources SET created_at=?,updated_at=? WHERE id=?').run(100,200,source.id);
 const denied=sources[4];f.lib.db.prepare('DELETE FROM storyboard_video_approvals WHERE id=?').run(f.catalog.managedKey(denied.id));
 const removed=sources[3];setData(f,removed,{removedAt:1000});
 const noCover=sources[2];setData(f,noCover,{managed:false});
 const byId=list=>new Map(list.folders.map(row=>[row.id,row]));
 let statusCalls=0;const status=f.entry.store.status.bind(f.entry.store);f.entry.store.status=async(...args)=>{statusCalls++;return status(...args);};
 const originalVerify=f.catalog.verification.verify;f.catalog.verification.verify=()=>assert.fail('summaries must not verify');
 const all=await f.catalog.list(f.project.id,{folderId:'all'});assert.equal(statusCalls,0);const summaries=byId(all);
 assert.equal(summaries.get(a.id).videoCount,4);assert.equal(summaries.get(b.id).videoCount,3);assert.equal(summaries.get(r.id).videoCount,1);assert.equal(summaries.get(rc.id).videoCount,1);assert.deepEqual(summaries.get(empty.id).covers,[]);
 const expected=[sources[0],sources[1]].sort((x,y)=>x.id<y.id?1:-1).map(s=>s.id);
 assert.deepEqual(summaries.get(a.id).covers.map(c=>c.videoId),expected);
 for(const cover of summaries.get(a.id).covers)assert.equal(cover.thumbnailUrl,(await f.catalog.dto(f.project.id,f.entry.store.source(f.project.id,cover.videoId),undefined,false)).thumbnailUrl);
 f.catalog.verification.verify=originalVerify;
 const snapshot=projectFolders(all);
 for(const options of [{folderId:'all',includeRejected:true},{folderId:'root'},{folderId:a.id},{folderId:b.id},{folderId:'reject'},{folderId:r.id}]){
  statusCalls=0;const list=await f.catalog.list(f.project.id,options);assert.deepEqual(projectFolders(list),snapshot);assert.equal(statusCalls,options.folderId==='all'?0:list.videos.length,'only existing visible-video status calls');
 }
 f.catalog.verification.verify=()=>assert.fail('metadata-only summary must not verify');
 f.entry.store.status=()=>assert.fail('metadata-only all view must not stat missing videos');
 await fs.rename(sources[0].path,sources[0].path+'.missing');
 const missing=byId(await f.catalog.list(f.project.id,{folderId:'all'}));assert.equal(missing.get(a.id).videoCount,4);assert.deepEqual(missing.get(a.id).covers,summaries.get(a.id).covers);
 // Database removal is reflected on the very next read.
 setData(f,sources[0],{removedAt:2000});assert.equal(byId(await f.catalog.list(f.project.id,{folderId:'all'})).get(a.id).videoCount,3);
 f.catalog.verification.verify=originalVerify;
 assert.ok(rejected.id&&root.id);
});


test('real moves and missing reject directory refresh summaries without making broken role available',async t=>{
 const f=await fixture(t),a=await folder(f,'from'),b=await folder(f,'to'),r=await folder(f,'reject');
 const source=await imported(f,'move.mp4',a.id);
 const before=await f.catalog.list(f.project.id,{folderId:'all'});assert.equal(before.folders.find(x=>x.id===a.id).videoCount,1);
 const plan=await f.catalog.fileOperations.preview(f.project.id,{requestId:randomUUID(),kind:'move-video',sourceId:source.id,destinationFolderId:b.id});
 await f.catalog.fileOperations.execute(f.project.id,{requestId:plan.requestId,previewHash:plan.previewHash,confirmUnbind:true});
 await f.catalog.queue;
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.catalog.fileOperations.row(f.project.id,plan.requestId).status,'ready');
 const moved=await f.catalog.list(f.project.id,{folderId:'all'});assert.equal(moved.folders.find(x=>x.id===a.id).videoCount,0);assert.equal(moved.folders.find(x=>x.id===b.id).videoCount,1);assert.equal(moved.folders.find(x=>x.id===b.id).covers[0].videoId,source.id);
 await imported(f,'reject.mp4',r.id);const settings=f.catalog.folders.settingsRow(f.project.id);f.catalog.folders.writeSettings(f.project.id,{...f.catalog.folders.settingsData(settings),rejectFolderId:r.id},settings?.revision||0);
 await fs.rename(r.path,r.path+'.missing');const broken=await f.catalog.list(f.project.id,{folderId:'all'});
 assert.equal(broken.folderRoles.needsReview,true);assert.equal(broken.folders.find(x=>x.id===r.id).videoCount,1);assert.equal(broken.folders.find(x=>x.id===r.id).covers.length,1);
});
