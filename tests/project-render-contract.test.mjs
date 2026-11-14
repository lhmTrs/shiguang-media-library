import {VideoMedia} from '../server/storyboard-video/media.mjs';
import {spawn} from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import express from 'express';
import {once} from 'node:events';
import {createReadStream} from 'node:fs';
import {fixture,uid,imported,linkInput,link,settled} from './helpers/project-render-fixture.mjs';
import {migrateRenderSchema,ProjectRenders,projectRenderRouter} from '../server/project-renders.mjs';
import {mysqlColumnType} from '../server/mysql.mjs';
import {projectVideoRouter} from '../server/project-videos/router.mjs';
import {canonical} from '../server/project-assets/model.mjs';
const mock=JSON.parse(await fs.readFile(new URL('./fixtures/project-renders-v1.json',import.meta.url),'utf8'));
const keys=o=>Object.keys(o).sort();
async function server(t,f){
 const app=express();app.use(express.json());
 const sendMedia=async(req,res,file,h)=>{const s=await h.stat();res.set('Accept-Ranges','bytes').type('video/mp4');let start=0,end=s.size-1;if(req.headers.range){const m=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);if(!m||Number(m[1])>=s.size)return res.status(416).set('Content-Range',`bytes */${s.size}`).end();start=Number(m[1]);end=m[2]?Math.min(Number(m[2]),end):end;res.status(206).set('Content-Range',`bytes ${start}-${end}/${s.size}`);}res.set('Content-Length',end-start+1);if(req.method==='HEAD')return res.end();const stream=createReadStream(file,{fd:h.fd,autoClose:false,start,end});stream.on('error',()=>res.destroy());res.once('close',()=>stream.destroy());stream.pipe(res);};
 app.use('/api/projects/:projectId/timelines/:timelineId/render',projectRenderRouter(f.renders,{sendMedia}));app.use('/api/project-videos',projectVideoRouter(f.catalog,{sendMedia}));
 const http=app.listen(0,'127.0.0.1');await once(http,'listening');t.after(()=>new Promise((r,j)=>http.close(e=>e?j(e):r())));
 const base='http://127.0.0.1:'+http.address().port,render=`/api/projects/${f.project.id}/timelines/${f.timelineId}/render`;
 return{base,render,request:async(url,method='GET',body,headers={})=>{const r=await fetch(base+url,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,headers:r.headers,body:method==='HEAD'?null:r.headers.get('content-type')?.includes('json')?await r.json():Buffer.from(await r.arrayBuffer())};}};
}
test('HTTP fixed contract, queryable 415/failed/unknown and kind routing, request replay after lost response',async t=>{
 const f=await fixture(t),s=await imported(f),h=await server(t,f);const empty=await h.request(h.render+'?schema=2');assert.equal(empty.status,200);assert.deepEqual(keys(empty.body),keys(mock.cases.find(c=>c.id==='render-unlinked').response.body));assert.equal((await h.request(h.render)).body,null);
 const input=linkInput(f,s);let first=await h.request(h.render,'POST',input);assert.ok([200,202].includes(first.status));let result=await settled(f,first.body);assert.equal(result.status,'completed');const replay=await h.request(h.render,'POST',input);assert.equal(replay.body.status,'completed');assert.equal(replay.body.result.render.revision,1);assert.deepEqual(keys(replay.body),keys(mock.cases.find(c=>c.id==='link-completed').response.body));
 const other=await h.request(h.render+'/choose','POST',{});assert.equal(other.status,410);assert.equal(other.body.code,'RENDER_LEGACY_SELECTION_DISABLED');const arbitrary=await h.request(h.render,'POST',{requestId:uid(),path:f.file});assert.equal(arbitrary.status,400);assert.equal(arbitrary.body.accepted,false);assert.ok(arbitrary.body.message);
 const ensureId=uid(),ensurePath=`/api/project-videos/projects/${f.project.id}/folders/final/ensure`;const ensure=await h.request(ensurePath,'POST',{requestId:ensureId,expectedRolesRevision:0});await settled(f,ensure.body);const receipt=await h.request(`/api/project-videos/projects/${f.project.id}/operations/${ensureId}`);assert.equal(receipt.body.action,'final-folder-ensure');assert.equal(receipt.body.status,'completed');
 const recovery=await h.request(`/api/project-videos/projects/${f.project.id}/operations/${ensureId}/recover`,'POST',{action:'rollback'});assert.ok(recovery.status>=400);assert.equal((await h.request(`/api/project-videos/projects/${f.project.id}/operations/${ensureId}`)).body.status,'completed');
});
test('GET/HEAD/Range/416/aborted streams and stale render revisions release tracked resources',async t=>{
 const f=await fixture(t),s=await imported(f);await link(f,s);const h=await server(t,f),url=h.render+'/media?renderRevision=1';let r=await h.request(url,'HEAD');assert.equal(r.status,200);assert.equal(Number(r.headers.get('content-length')),f.bytes.length);
 r=await h.request(url,'GET',null,{Range:'bytes=0-15'});assert.equal(r.status,206);assert.deepEqual(r.body,f.bytes.subarray(0,16));r=await h.request(url,'HEAD',null,{Range:'bytes=0-15'});assert.equal(r.status,206);assert.equal(r.headers.get('content-length'),'16');
 r=await h.request(url,'GET',null,{Range:'bytes=999999-'});assert.equal(r.status,416);r=await h.request(h.render+'/media?renderRevision=0');assert.equal(r.status,409);assert.equal(r.body.code,'RENDER_CONFLICT');
 const controller=new AbortController();const response=await fetch(h.base+url,{signal:controller.signal});controller.abort();await response.body.cancel().catch(()=>{});await new Promise(r=>setTimeout(r,15));await Promise.all([...f.entry.media.closes]);assert.equal(f.entry.media.handles.size,0);assert.equal(f.entry.media.responses.size,0);
});
test('explicit single-file information refresh persists dimensions, strict source keys and cannot accept another content',async t=>{
 const f=await fixture(t),s=await imported(f),original=JSON.parse(s.data_json);f.lib.db.prepare('UPDATE storyboard_video_sources SET data_json=? WHERE id=?').run(canonical({...original,codec:'unknown',supported:false}),s.id);const source=f.entry.store.source(f.project.id,s.id);f.entry.store.approve(source);f.catalog.approveManaged(source);
 const r=await settled(f,await f.catalog.mediaInfo.refresh(f.project.id,s.id,{requestId:uid(),expectedRevision:1}));assert.equal(r.status,'completed');assert.equal(r.result.source.width,64);assert.equal(r.result.source.height,48);assert.equal(r.result.source.playback.supported,true);assert.equal(r.result.source.sourceRevision,2);assert.deepEqual(keys(JSON.parse(f.entry.store.source(f.project.id,s.id).data_json)),keys(original));
 await fs.appendFile(s.path,'different unverified content');await assert.rejects(f.catalog.mediaInfo.refresh(f.project.id,s.id,{requestId:uid(),expectedRevision:2}),e=>['RENDER_SOURCE_REVIEW_REQUIRED','RENDER_SOURCE_CHANGED'].includes(e.code));assert.equal(f.catalog.row(f.project.id,s.id).revision,2);
});
test('old SQLite startup/GET never ALTER; explicit migration preserves bytes, idempotent and MySQL integer mapping',async t=>{
 const f=await fixture(t);f.lib.db.exec('DROP TABLE project_renders;CREATE TABLE project_renders(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,payload TEXT NOT NULL)');const st=await fs.stat(f.file),payload=JSON.stringify({path:f.file,offset:0,dev:String(st.dev),ino:String(st.ino),size:st.size,mtime:st.mtimeMs,updatedAt:Date.now()},null,2);f.lib.db.prepare('INSERT INTO project_renders VALUES(?,?,?)').run(f.timelineId,f.project.id,payload);
 new ProjectRenders(f.projects).init();assert.equal((await f.renders.get(f.project.id,f.timelineId,{schema:2})).revision,1);assert.equal(f.lib.db.prepare('PRAGMA table_info(project_renders)').all().some(c=>c.name==='revision'),false);
 const dry=await migrateRenderSchema(f.lib.db);assert.equal(dry.applied,false);assert.equal(dry.needed,true);assert.equal((await migrateRenderSchema(f.lib.db,{apply:true,backupFile:path.join(f.dir,'migration.json')})).applied,true);assert.equal(f.lib.db.prepare('SELECT payload FROM project_renders').get().payload,payload);assert.equal((await migrateRenderSchema(f.lib.db,{apply:true})).needed,false);
 assert.equal(mysqlColumnType('project_renders',{name:'revision',type:'INTEGER'}),'BIGINT');assert.equal(mysqlColumnType('project_timelines',{name:'revision',type:'TEXT'}),'VARCHAR(36)');
 const fake={kind:'mysql',prepare(sql){return{all:()=>sql.includes('information_schema')?[{name:'id',type:'varchar'},{name:'project_id',type:'varchar'},{name:'payload',type:'longtext'}]:[]};}};assert.match((await migrateRenderSchema(fake)).sql,/revision BIGINT NOT NULL DEFAULT 1/);
});
test('new and old backups strict, optional final/mediaInfo, operations and approvals never restored',async t=>{
 const f=await fixture(t),s=await imported(f);await link(f,s);const snapshot=f.renders.snapshot();assert.equal(snapshot.schemaVersion,2);assert.equal(f.renders.validateBackup(snapshot).length,1);assert.throws(()=>f.renders.validateBackup({...snapshot,extra:true}),{code:'RENDER_BACKUP_INVALID'});const bad=structuredClone(snapshot);bad.rows[0].revision='1';assert.throws(()=>f.renders.validateBackup(bad),{code:'RENDER_BACKUP_INVALID'});
 const video=f.entry.store.snapshot();assert.equal(Object.hasOwn(video,'project_video_operations'),false);assert.equal(Object.hasOwn(video,'storyboard_video_approvals'),false);assert.doesNotThrow(()=>f.entry.store.validateBackup(video,[],[f.project,f.other]));
 const unknown=structuredClone(video);unknown.project_video_records[0].data_json=canonical({...JSON.parse(unknown.project_video_records[0].data_json),unexpected:3});assert.throws(()=>f.entry.store.validateBackup(unknown,[],[f.project]),{code:'VIDEO_BACKUP_INVALID'});
 const ensured=await f.catalog.finalFolder.ensureResolved(f.project.id,{requestId:uid(),expectedRolesRevision:0}),current=f.entry.store.snapshot();assert.doesNotThrow(()=>f.entry.store.validateBackup(current,[],[f.project]));const wrong=structuredClone(current);wrong.project_video_settings[0].data_json=canonical({...JSON.parse(wrong.project_video_settings[0].data_json),finalFolderId:uid()});assert.throws(()=>f.entry.store.validateBackup(wrong,[],[f.project]),{code:'VIDEO_BACKUP_INVALID'});
});
test('overview preserves warnings/key/retained/disabled and stable per-revision occurrence identity',async t=>{
 const f=await fixture(t),ref={key:'r',assetId:null,name:'待确认.wav',used:false,retained:false,occurrences:[{clipId:null,track:1,start:10,end:14,sourceIn:0,sourceOut:4,disabled:false},{clipId:null,track:1,start:10,end:14,disabled:true}]},snapshot={fps:25,duration:57,warnings:['XML warning'],refs:[ref,{...ref,key:'retained',retained:true}]};f.lib.db.prepare('UPDATE project_timelines SET snapshot=? WHERE id=?').run(JSON.stringify(snapshot),f.timelineId);
 const view=f.projects.imports.overview(f.project.id),again=f.projects.imports.overview(f.project.id);assert.equal(view.projectId,f.project.id);assert.deepEqual(view.timelines[0].warnings,['XML warning']);assert.deepEqual(view,again);const refs=view.timelines[0].references;assert.equal(refs[1].retained,true);assert.notEqual(refs[0].occurrences[0].occurrenceId,refs[0].occurrences[1].occurrenceId);
 const current=(time)=>refs.filter(r=>!r.retained).flatMap(r=>r.occurrences).filter(o=>!o.disabled&&o.start!=null&&o.start<=time&&time<o.end);assert.equal(current(12).length,1);assert.equal(current(14).length,0);assert.equal(current(-2).length,0);
 f.lib.db.prepare('UPDATE project_timelines SET revision=? WHERE id=?').run(uid(),f.timelineId);assert.notEqual(f.projects.imports.overview(f.project.id).timelines[0].references[0].occurrences[0].occurrenceId,refs[0].occurrences[0].occurrenceId);
});
test('identical-UUID second SQLite cannot receive admitted render hash or video-info probe results',async t=>{
 for(const kind of ['render','info']){const f=await fixture(t),s=await imported(f),originalDb=f.lib.db,copy=path.join(f.dir,'other-library.sqlite');await originalDb.backup(copy);const other=new Database(copy);let switched=false;
 const owner=kind==='render'?f.catalog:f.entry.media,method=kind==='render'?'hash':'probe',original=owner[method].bind(owner);owner[method]=async(...args)=>{const result=await original(...args);if(!switched){switched=true;f.lib.db=other;}return result;};
 let result;try{result=kind==='render'?await f.renders.save(f.project.id,f.timelineId,linkInput(f,s)):await f.catalog.mediaInfo.refresh(f.project.id,s.id,{requestId:uid(),expectedRevision:1});if(result)await settled(f,result);}catch(e){assert.ok(['LOCAL_INSTANCE_CHANGED','OPERATION_NOT_FOUND'].includes(e.code));}
 assert.equal(other.prepare('SELECT COUNT(*) n FROM project_renders').get().n,0);assert.equal(other.prepare('SELECT COUNT(*) n FROM project_video_operations').get().n,0);assert.equal(other.prepare('SELECT revision FROM project_video_records WHERE id=?').get(s.id).revision,1);
 f.lib.db=originalDb;owner[method]=original;await f.catalog.usageJournal.settle();const receipt=originalDb.prepare("SELECT data_json FROM project_video_operations WHERE project_id=?").all(f.project.id).map(r=>JSON.parse(r.data_json)).find(r=>r.namespace==='project-usage-render-v1');assert.equal(receipt.status,'failed');assert.equal(receipt.error.code,'LOCAL_INSTANCE_CHANGED');other.close();}
});

test('production app retains local session/token/Host guards and normally closes its real listener',async t=>{
 const f=await fixture(t),s=await imported(f);await link(f,s);const assetId=f.catalog.metadata(f.project.id,s).data.mediaAssetId,oldOperation=uid();f.lib.db.prepare('INSERT INTO operations(id,asset_id,action,source,target,status,created_at) VALUES(?,?,?,?,?,?,?)').run(oldOperation,assetId,'rename',path.join(path.dirname(s.path),'previous.mp4'),s.path,'done',new Date().toISOString());f.lib.db.prepare("UPDATE assets SET probe='ready',capture_status='ready' WHERE id=?").run(assetId);await f.close();
 const child=spawn(process.execPath,['server/index.mjs'],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,MEDIA_DATA_DIR:f.lib.dataDir,MEDIA_PERSONAL_ITEM_DIR:path.join(f.dir,'personal_item'),MEDIA_PORTABLE:'1',MEDIA_SKIP_IMPORT:'1',MEDIA_SKIP_RECONCILE:'1',MEDIA_NO_WATCH:'1',MEDIA_CONTAINER:'0',PORT:'45940',MEDIA_DISABLE_DESKTOP_NATIVE:'1',MEDIA_CODEX_AUTOCONNECT:'0'},stdio:['ignore','pipe','pipe']});
 let output='',exited=false;child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);const exit=once(child,'close').then(v=>{exited=true;return v;});
 const stop=async()=>{if(!exited)child.kill('SIGTERM');let timer;try{const value=await Promise.race([exit,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Owned application did not close normally')),15000);})]);assert.deepEqual(value,[0,null]);assert.match(output,/APPLICATION_CLOSED_KNOWN/);}finally{clearTimeout(timer);await fs.writeFile(path.join(f.dir,'owned-app.log'),output);}};t.after(stop);
 const deadline=Date.now()+15000;while(!output.match(/拾光素材库 http:\/\/127\.0\.0\.1:(\d+)/)){if(exited||Date.now()>deadline)throw Error('Owned startup failed: '+output);await new Promise(r=>setTimeout(r,10));}
 const base=output.match(/拾光素材库 (http:\/\/127\.0\.0\.1:\d+)/)[1],url=`/api/projects/${f.project.id}/timelines/${f.timelineId}/render`;
 assert.equal((await fetch(base+url+'?schema=2')).status,401);const session=await fetch(base+'/api/session'),cookie=session.headers.get('set-cookie').split(';')[0],{token}=await session.json();
 assert.equal((await fetch(base+url,{method:'DELETE',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({requestId:uid(),expectedRevision:1})})).status,403);
 const read=await fetch(base+url+'?schema=2',{headers:{Cookie:cookie}});assert.equal(read.status,200);assert.equal((await read.json()).sourceId,s.id);
 const range=await fetch(base+url+'/media?renderRevision=1',{headers:{Cookie:cookie,Range:'bytes=0-15'}});assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),f.bytes.subarray(0,16));
 const head=await fetch(base+url+'/media?renderRevision=1',{method:'HEAD',headers:{Cookie:cookie,Range:'bytes=0-15'}});assert.equal(head.status,206);assert.equal(head.headers.get('content-length'),'16');
 const bad=await fetch(base+url+'/choose',{method:'POST',headers:{Cookie:cookie,'X-Local-Token':token,'Content-Type':'application/json'},body:'{}'});assert.equal(bad.status,410);
 const list=await fetch(base+`/api/project-videos/projects/${f.project.id}`,{headers:{Cookie:cookie}});assert.equal(list.status,200);
 const preview=await fetch(base+'/api/operations/preview',{method:'POST',headers:{Cookie:cookie,'X-Local-Token':token,'Content-Type':'application/json'},body:JSON.stringify({action:'rename',ids:[assetId],name:'unused.mp4'})});assert.equal(preview.status,409);assert.equal((await preview.json()).code,'RENDER_IN_USE');
 const undo=await fetch(base+`/api/operations/${oldOperation}/undo`,{method:'POST',headers:{Cookie:cookie,'X-Local-Token':token,'Content-Type':'application/json'},body:'{}'});assert.equal(undo.status,409);assert.ok((await undo.json()).details.references.length);
});

test('aborted POST keeps its durable request, completes once, and replays without revision increment',async t=>{
 const f=await fixture(t),s=await imported(f),h=await server(t,f),hash=f.catalog.hash.bind(f.catalog);let release,entered;const gate=new Promise(r=>release=r),admitted=new Promise(r=>entered=r);f.catalog.hash=async(...args)=>{entered();await gate;return hash(...args);};
 const input=linkInput(f,s),controller=new AbortController(),post=fetch(h.base+h.render,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal:controller.signal});post.catch(()=>{});
 await admitted;controller.abort();await assert.rejects(post);release();await f.catalog.usageJournal.active.get(input.requestId);
 const query=await h.request(h.render+'/requests/'+input.requestId);assert.equal(query.status,200);assert.equal(query.body.status,'completed');assert.equal(query.body.result.render.revision,1);
 const replay=await h.request(h.render,'POST',input);assert.equal(replay.body.status,'completed');assert.equal(replay.body.result.render.revision,1);assert.equal((await f.renders.get(f.project.id,f.timelineId,{schema:2})).revision,1);
 const raw=JSON.parse(f.entry.store.source(f.project.id,s.id).data_json);f.lib.db.prepare('UPDATE storyboard_video_sources SET data_json=? WHERE id=?').run(canonical({...raw,codec:'prores',supported:false}),s.id);const changed=f.entry.store.source(f.project.id,s.id);f.entry.store.approve(changed);f.catalog.approveManaged(changed);
 const rejected=await h.request(h.render,'POST',linkInput(f,changed));assert.equal(rejected.status,415);assert.equal(rejected.body.accepted,true);assert.ok(rejected.body.details.statusUrl);const failure=await h.request(rejected.body.statusUrl);assert.equal(failure.status,200);assert.equal(failure.body.status,'failed');assert.equal(failure.body.error.code,'RENDER_CODEC_UNSUPPORTED');
});

test('explicit probes have bounded output/time and normally settle their descriptor and child',async t=>{
 const f=await fixture(t);
 for(const kind of ['timeout','output']){const command=path.join(f.dir,'synthetic-probe-'+kind+'.mjs');await fs.writeFile(command,`#!${process.execPath}\n${kind==='output'?"process.stdout.write('x'.repeat(100000));":""}setInterval(()=>{},1000);\n`,{mode:0o700});const media=new VideoMedia({command,probeMs:kind==='timeout'?100:2000});
 try{await assert.rejects(media.probe(f.file),{code:kind==='timeout'?'PROBE_TIMEOUT':'PROBE_OUTPUT_LIMIT'});assert.equal(media.children.size,0);assert.equal(media.handles.size,0);assert.equal(media.exits.size,0);}finally{await media.close();}}
});
