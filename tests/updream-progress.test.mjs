import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {UpdreamProgress} from '../server/updream-progress/store.mjs';
import {progressFixture} from './helpers/updream-progress-fixture.mjs';
const store=f=>new UpdreamProgress({dataDir:f.data,queueDir:f.queue,libraryId:f.instance,resolveVideo:()=>true,projectName:()=> '合成项目'});

test('read-only registered tasks, safe phases, no invented percentage/upstream time; no business file writes',async t=>{
 const f=await progressFixture(t),s=store(f),job=await f.put('active',{}, {generation:{task_id:'active',status:'processing',progress:50}});
 const before=await Promise.all([fs.readFile(job.file),fs.readFile(job.source)]),listed=await s.list();
 assert.equal(listed.tasks[0].phase,'generating');assert.equal(listed.tasks[0].active,true);assert.equal(listed.tasks[0].progress,null);assert.equal(listed.tasks[0].upstreamUpdatedAt,null);assert.equal(listed.tasks[0].target.identity,'unconfirmed');assert.equal(listed.summary.showEntry,true);
 assert.ok(!JSON.stringify(listed).includes('PRIVATE'));assert.ok(!JSON.stringify(listed).includes('video_url'));
 assert.deepEqual(await Promise.all([fs.readFile(job.file),fs.readFile(job.source)]),before);await assert.rejects(fs.access(s.preferences),{code:'ENOENT'});
});

test('absent queue is not created; broken/unknown/oversize/symlink records degrade without breaking healthy tasks',async t=>{
 const f=await progressFixture(t);let s=new UpdreamProgress({dataDir:f.data,queueDir:path.join(f.root,'absent')});assert.equal((await s.list()).queue.state,'absent');await assert.rejects(fs.access(s.queueDir),{code:'ENOENT'});
 const ok=await f.put('ok'),broken=await f.put('broken'),unknown=await f.put('unknown',{version:99}),link=await f.put('link'),large=await f.put('large');
 await fs.writeFile(broken.file,'{"half":');await fs.unlink(link.file);await fs.symlink(ok.file,link.file);await fs.writeFile(large.file,' '.repeat(8*1024*1024+1));
 s=store(f);const listed=await s.list();assert.equal(listed.queue.state,'degraded');assert.equal(listed.queue.invalidCount,4);assert.equal(listed.queue.warning,true);assert.equal(listed.tasks.find(t=>t.id==='ok').phase,'generating');assert.equal(listed.tasks.length,1);assert.equal(listed.diagnostics.count,4);assert.equal(listed.summary.attentionCount,0);
 await fs.rename(f.queue,f.queue+'-original');await fs.symlink(f.queue+'-original',f.queue);assert.equal((await s.list()).queue.state,'unavailable');
});

test('missing historical source records stay readable as diagnostics but never count as task alerts',async t=>{
 const f=await progressFixture(t),s=store(f);
 for(let index=0;index<23;index++){
  const job=await f.put('historic-'+index,{stage:index<21?'done':'failed'});
  await fs.unlink(job.source);
 }
 for(let index=0;index<3;index++){
  const id='delivered-'+index;
  await f.put(id,{stage:'done'},{generation:{task_id:id,status:'completed'},delivery:f.delivered(id)});
 }
 let listing=await s.list({limit:2});
 assert.deepEqual(listing.summary,{activeCount:0,unreadCount:3,attentionCount:0,attentionUnreadCount:0,doneUnreadCount:3,diagnosticCount:23,showEntry:true});
 assert.equal(listing.total,3);assert.equal(listing.tasks.length,2);assert.equal(listing.queue.warning,false);
 assert.deepEqual(listing.diagnostics.byReason,{state_missing:23});
 assert.deepEqual(listing.diagnostics.legacyStatus,{done:21,failed:2});
 assert.ok(listing.diagnostics.items.every(item=>item.registeredAt===1700000000000));
 assert.ok(!JSON.stringify(listing.diagnostics).includes(f.sources));
 const diagnostic=(await s.detail('historic-0')).task;
 assert.equal(diagnostic.attention.code,'state_missing');
 assert.equal(diagnostic.unread,false);
 assert.deepEqual((await s.markRead({items:[{id:diagnostic.id,version:diagnostic.eventVersion}]})).skipped,[diagnostic.id]);
 const pending=await f.put('missing-in-progress',{stage:'monitoring'});await fs.unlink(pending.source);
 await f.put('actual-failure',{stage:'failed'},{generation:{task_id:'actual-failure',status:'failed'}});
 listing=await s.list();
 assert.equal(listing.summary.attentionCount,1);assert.equal(listing.summary.attentionUnreadCount,1);assert.equal(listing.summary.doneUnreadCount,3);
 assert.equal(listing.diagnostics.count,24);assert.equal(listing.queue.warning,true);
 assert.deepEqual(listing.tasks.filter(item=>item.attention).map(item=>item.id),['actual-failure']);
 for(let index=23;index<50;index++){
  const job=await f.put('historic-'+index,{stage:'done'});
  await fs.unlink(job.source);
 }
 const capped=await s.list({scope:'history',offset:99,limit:1});
 assert.equal(capped.tasks.length,0);assert.equal(capped.diagnostics.count,51);
 assert.equal(capped.diagnostics.items.length,50);assert.equal(capped.diagnostics.truncated,true);
});

test('verified import is distinct from generation complete and notification failure; wrong library cannot view',async t=>{
 const f=await progressFixture(t),s=store(f);
 await f.put('generated',{}, {generation:{task_id:'generated',status:'completed'}});
 await f.put('waiting',{stage:'waiting_library'},{generation:{task_id:'waiting',status:'completed'},download_result:{probe:{ok:true},sha256:'a'.repeat(64)}});
 await f.put('importing',{stage:'waiting_library'},{generation:{task_id:'importing',status:'completed'},delivery:{stage:'importing'}});
 const d=f.delivered('done');await f.put('done',{stage:'needs_user',attention:'claude_status_unknown',notification:{stage:'send_uncertain',body:'PRIVATE_NOTIFY'}},{generation:{task_id:'done',status:'completed'},delivery:d});
 let tasks=(await s.list()).tasks;assert.equal(tasks.find(t=>t.id==='generated').phase,'downloading');assert.equal(tasks.find(t=>t.id==='waiting').phase,'waiting_import');assert.equal(tasks.find(t=>t.id==='importing').phase,'importing');const done=tasks.find(t=>t.id==='done');assert.equal(done.phase,'imported');assert.equal(done.delivery.canView,true);assert.ok(done.attention);assert.equal(done.target.identity,'current');assert.equal(done.active,false);assert.equal(done.notification.state,'send_uncertain');assert.ok(!JSON.stringify(done).includes('PRIVATE'));
 const other=new UpdreamProgress({dataDir:f.data,queueDir:f.queue,libraryId:'other',resolveVideo:()=>true});const foreign=(await other.detail('done')).task;assert.equal(foreign.target.identity,'other_library');assert.equal(foreign.delivery.canView,false);
 await f.put('unverified',{stage:'done'},{generation:{task_id:'unverified',status:'completed'},delivery:{...f.delivered('unverified'),verified:false}});assert.equal((await s.detail('unverified')).task.phase,'needs_review');
 await f.put('changed',{stage:'done',delivery_sha256:'b'.repeat(64)},{generation:{task_id:'changed',status:'completed'},delivery:f.delivered('changed')});assert.equal((await s.detail('changed')).task.phase,'needs_review');
});

test('exact-version read preferences survive restart, concurrent windows, late reads and new exceptions; originals unchanged',async t=>{
 const f=await progressFixture(t),s=store(f),j=await f.put('failed',{stage:'failed'},{generation:{task_id:'failed',status:'failed',error:'PRIVATE_ERROR'}});
 const before=await fs.readFile(j.file);let task=(await s.detail('failed')).task;assert.equal(task.unread,true);const version=task.eventVersion;
 assert.deepEqual((await s.markRead({items:[{id:task.id,version}]})).marked,['failed']);assert.equal((await store(f).detail('failed')).task.unread,false);
 assert.deepEqual((await s.markRead({items:[{id:task.id,version:'f'.repeat(64)}]})).skipped,['failed']);
 assert.equal((await s.detail('failed')).task.eventVersion,version);await fs.utimes(j.file,new Date(),new Date());assert.equal((await s.detail('failed')).task.unread,false);
 await Promise.all([s.markRead({items:[{id:'failed',version}]}),s.markRead({items:[{id:'failed',version}]})]);
 assert.deepEqual(await fs.readFile(j.file),before);
 await f.put('failed',{stage:'needs_user',attention:'login_required'},{generation:{task_id:'failed',status:'failed'}});task=(await s.detail('failed')).task;assert.notEqual(task.eventVersion,version);assert.equal(task.unread,true);
 await s.markRead({items:[{id:task.id,version:task.eventVersion}]});await f.put('failed',{stage:'needs_user',attention:'retry_budget_exhausted'},{generation:{task_id:'failed',status:'failed'}});assert.equal((await s.detail('failed')).task.unread,true);
 const history=await s.list({scope:'history',limit:1});assert.equal(history.tasks.length,1);assert.equal(history.summary.activeCount,0);
});

test('private preferences reject unsafe links/unknown version and lock contention without touching task state',async t=>{
 const f=await progressFixture(t),s=store(f);await f.put('failed',{stage:'failed'},{generation:{task_id:'failed',status:'failed'}});const task=(await s.detail('failed')).task;
 await s.markRead({items:[{id:task.id,version:task.eventVersion}]});await fs.writeFile(path.join(s.preferences,'read.lock'),'held',{mode:0o600});await assert.rejects(s.markRead({items:[{id:task.id,version:task.eventVersion}]}),{code:'preferences_busy'});await fs.unlink(path.join(s.preferences,'read.lock'));
 await fs.writeFile(path.join(s.preferences,'read.json'),'{"version":99,"read":{}}');assert.equal((await s.list()).preferences.state,'unavailable');await assert.rejects(s.markRead({items:[{id:task.id,version:task.eventVersion}]}),{code:'preferences_unavailable'});
 assert.equal((await s.detail('failed')).task.phase,'failed');
});

test('local cancellation is not platform cancellation; independent notification updates do not re-alert imported result',async t=>{
 const f=await progressFixture(t),s=store(f);await f.put('stopped',{stage:'cancelled',local_cancel_only:true});let task=(await s.detail('stopped')).task;assert.equal(task.phase,'needs_review');assert.equal(task.attention.code,'local_followup_stopped');assert.equal(task.active,false);
 const delivery=f.delivered('delivered');const job=await f.put('delivered',{stage:'notifying',notification:{stage:'queued'}},{generation:{task_id:'delivered',status:'completed'},delivery});task=(await s.detail('delivered')).task;assert.equal(task.phase,'imported');assert.equal(task.active,false);
 await s.markRead({items:[{id:'delivered',version:task.eventVersion}]});await fs.writeFile(job.file,JSON.stringify({...job.q,stage:'done',notification:{stage:'delivered'}}));const done=(await s.detail('delivered')).task;assert.equal(done.unread,false);assert.equal(done.eventVersion,task.eventVersion);assert.equal(done.notification.state,'delivered');
});

test('source identity/version/ancestor links and permissions are rejected without inspecting unregistered files',async t=>{
 const f=await progressFixture(t),s=store(f),job=await f.put('source');await fs.writeFile(path.join(f.sources,'unregistered.json'),'{"private":"DO_NOT_SCAN"}');
 assert.equal((await s.list()).tasks.length,1);
 await fs.writeFile(job.source,JSON.stringify({...job.state,version:2}));assert.equal((await s.detail('source')).task.phase,'needs_review');
 await fs.writeFile(job.source,JSON.stringify({...job.state,generation:{task_id:'other',status:'completed'}}));assert.equal((await s.detail('source')).task.phase,'needs_review');
 await fs.writeFile(job.source,JSON.stringify(job.state));await fs.rename(f.sources,f.sources+'-old');await fs.symlink(f.sources+'-old',f.sources);assert.equal((await s.list()).queue.state,'degraded');
 await fs.chmod(f.queue,0o755);assert.equal((await s.list()).queue.state,'unavailable');
});

test('bounded queue pagination and stale local records never pretend to be successful platform updates',async t=>{
 const f=await progressFixture(t),s=store(f);for(let i=0;i<202;i++)await f.put('task-'+i);
 const limited=await s.list({limit:5});assert.equal(limited.tasks.length,5);assert.equal(limited.total,200);assert.equal(limited.queue.truncated,true);assert.equal(limited.queue.state,'degraded');
 assert.equal((await s.list({scope:'active',offset:199,limit:2})).tasks.length,1);
 const task=await f.put('stale');const old=new Date(Date.now()-300000);await fs.utimes(task.file,old,old);await fs.utimes(task.source,old,old);
 // Its filename may fall outside the first capped snapshot, so use a separate bounded queue.
 for(const name of await fs.readdir(f.jobs))if(path.join(f.jobs,name)!==task.file)await fs.unlink(path.join(f.jobs,name));
 const stale=(await s.detail('stale')).task;assert.equal(stale.stale.reason,'local_record_old');assert.equal(stale.upstreamUpdatedAt,null);
 await assert.rejects(s.list({limit:101}),{code:'invalid_input'});await assert.rejects(s.markRead({items:[]}),{code:'invalid_input'});
});
