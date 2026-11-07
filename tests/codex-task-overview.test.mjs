import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import express from 'express';
import {codexRouter} from '../server/prompt-codex/router.mjs';
import {taskSummary,safeText} from '../server/prompt-codex/tasks.mjs';
import {setup,conversation,request,start,finish,emit,until} from './codex-task-fixture.mjs';

test('three cross-template/project tasks, read-only polling and stored event clocks',async t=>{
 const s=await setup(t);await s.service.connect();const tasks=[];
 for(let n=0;n<3;n++)tasks.push(await start(s));
 const p=randomUUID();s.db.prepare('INSERT INTO media_projects VALUES(?,?,?)').run(p,'snapshot','normal');
 const target=s.store.getTurn(tasks[0].id);s.store.updateTurn(target.id,{actual:{...target.actual,pictureProject:{id:p,name:'old name'}}});
 s.db.prepare('UPDATE media_projects SET name=? WHERE id=?').run('new name',p);
 s.store.get=()=>{throw Error('overview loaded complete conversation');};s.store.recover=()=>{throw Error('GET recovered');};
 const changes=s.db.prepare('SELECT total_changes() n').get().n;
 const first=s.service.taskOverview({limit:1}),second=s.service.taskOverview({limit:1});
 assert.equal(first.activeCount,3);assert.equal(first.items.length,3);assert.equal(first.connection.active,3);
 assert.equal(new Set(first.items.map(i=>i.templateId)).size,3);
 assert.deepEqual(first.items.map(i=>i.updatedAt),second.items.map(i=>i.updatedAt));
 assert.equal(first.items.find(i=>i.taskId===target.id).project.name,'old name');
 assert.equal(s.db.prepare('SELECT total_changes() n').get().n,changes);
 assert.deepEqual(Object.keys(first.connection).sort(),['active','authenticated','connected','unsettled']);
 assert.equal(first.items.every(i=>i.phase==='waiting'),true);
 delete s.store.get;await assert.rejects(s.service.connect(),e=>e.status===409);
});

test('stable tied-time terminal pagination, all active every page, bounded SQL projection',async t=>{
 const s=await setup(t),head=conversation(s);let revision=head.revision;const ids=[];
 for(let n=0;n<135;n++){const input=request({...head,revision},{text:"synthetic follow-up"});s.store.begin(head.id,input);s.store.updateTurn(input.id,{status:'completed',blocks:[{type:'text',text:'reply '+n}]});revision=s.store.head(head.id).revision;ids.push(input.id);}
 s.db.prepare('UPDATE codex_turns SET created_at=?').run(1000);
 const active=conversation(s),queued=s.store.begin(active.id,request(active)).turn;
 const first=s.service.taskOverview({limit:13});let page=first,seen=[];
 do {assert.equal(page.activeCount,1);assert.equal(page.items.filter(i=>i.taskId===queued.id).length,1);seen.push(...page.items.filter(i=>i.status==='completed').map(i=>i.taskId));page=page.nextCursor?s.service.taskOverview({limit:13,cursor:page.nextCursor}):null;}while(page);
 assert.equal(seen.length,135);assert.equal(new Set(seen).size,135);assert.deepEqual(seen,[...ids].sort().reverse());
 assert.equal(s.service.taskOverview({limit:999}).items.length,101);
 assert.throws(()=>s.service.taskOverview({cursor:'bad'}),/游标/);
 assert.equal(first.historyScope.kind,'recent');assert.equal(first.historyScope.hasMore,true);
});

test('redacted bounded image summaries preserve failures beyond thumbnail cap and project deletion',async t=>{
 const s=await setup(t),head=conversation(s),pid=randomUUID();s.db.prepare('INSERT INTO media_projects VALUES(?,?,?)').run(pid,'项目','normal');
 const row=s.store.begin(head.id,request(head,{project_id:pid})).turn;
 const blocks=[{type:'text',text:'ok /Users/private/token.png C:\\private\\x.png file:///secret/key api_key=example-secret sk-example-private data:image/png;base64,AAAA '+'Z'.repeat(100)}];
 for(let n=0;n<18;n++){const id=randomUUID();s.store.addAttachment({id,turn_id:row.id,file_name:'secret.png',sha256:'0'.repeat(64),mime:'image/png',bytes:1,created_at:1,updated_at:1});blocks.push({type:'image',status:'ready',attachmentId:id,library:{status:n===17?'failed':'ready',error:'/secret/failure'}});}
 blocks.push({type:'image',status:'failed',error:'/secret/receive'});
 s.store.updateTurn(row.id,{blocks,status:'completed'});s.db.prepare('DELETE FROM media_projects WHERE id=?').run(pid);
 s.store.setDeleted(head.id,true,s.store.head(head.id).revision);
 s.db.prepare('UPDATE prompt_templates SET deleted_at=? WHERE id=?').run(1,head.template_id);
 const item=s.service.taskOverview().items[0],wire=JSON.stringify(item);
 assert.equal(item.images.length,16);assert.equal(item.imageCount,19);assert.equal(item.project.available,false);
 assert.equal(item.conversationDeleted,true);assert.equal(item.templateDeleted,true);
 assert.deepEqual(item.attention.reasons.sort(),['IMAGE_LIBRARY_FAILED','IMAGE_RECEIVE_FAILED']);
 assert.equal(item.phase,'completed');assert.equal(item.preview.length<=240,true);
 for(const secret of ['/Users/','private','example-secret','sk-example','data:image','secret.png','relativePath','request_json','blocks_json'])assert.equal(wire.includes(secret),false,secret);
 assert.equal(item.images.every(i=>i.url.startsWith('/api/prompt-codex/images/')),true);
 assert.ok(item.terminalRevision.endsWith(':'+item.updatedAt));
});

test('oversized legacy output is explicitly unavailable; read cannot recover or reclassify as success',async t=>{
 const s=await setup(t),head=conversation(s),row=s.store.begin(head.id,request(head)).turn;
 s.db.prepare('UPDATE codex_turns SET blocks_json=?,actual_json=?,request_json=? WHERE id=?').run(JSON.stringify([{type:'text',text:'private'.repeat(20000)}]),'{}',JSON.stringify({text:'secret'.repeat(20000)}),row.id);
 const changes=s.db.prepare('SELECT total_changes() n').get().n;const before=s.service.taskOverview().items[0];
 assert.equal(before.summaryUnavailable,true);assert.equal(before.project,null);assert.equal(before.status,'queued');
 assert.equal(s.db.prepare('SELECT total_changes() n').get().n,changes);
 s.store.recover();const after=s.service.taskOverview().items[0];assert.equal(after.status,'interrupted');assert.equal(after.errorCode,'APPLICATION_RESTARTED');assert.ok(after.attention.required);
});

test('actual image event phase, receive failure and library failure through generation path',async t=>{
 const s=await setup(t);await s.service.connect();const task=await start(s);
 emit(s,task,'item/started',{item:{id:'image',type:'imageGeneration'}});await task.queue;
 await until(()=>s.service.taskOverview().items[0].phase==='imageProcessing');
 await finish(s,task,[{id:'image',type:'imageGeneration',status:'failed'}]);
 const item=s.service.taskOverview().items[0];assert.equal(item.status,'completed');assert.ok(item.attention.reasons.includes('IMAGE_RECEIVE_FAILED'));
});

test('actual HTTP task routes stay read-only, stop token required, and original deleted GET remains exact',async t=>{
 const s=await setup(t),head=conversation(s),row=s.store.begin(head.id,request(head)).turn;s.store.updateTurn(row.id,{status:'interrupted',errorCode:'USER_STOPPED'});
 s.store.setDeleted(head.id,true,s.store.head(head.id).revision);
 const app=express();app.use('/api/prompt-codex',codexRouter(s.store,s.service,s.media,{}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());
 const base='http://127.0.0.1:'+server.address().port+'/api/prompt-codex',changes=s.db.prepare('SELECT total_changes() n').get().n;
 const response=await fetch(base+'/tasks');assert.equal(response.headers.get('cache-control'),'no-store');const data=await response.json();assert.equal(data.items[0].phase,'stopped');
 const impact=await(await fetch(base+'/tasks/'+row.id+'/stop-impact')).json();assert.equal(impact.requiresConfirmation,false);assert.equal(impact.otherTasks.length,0);
 const original=await(await fetch(base+'/conversations/'+head.id)).json();assert.equal(original.id,head.id);assert.equal(original.turns[0].id,row.id);assert.ok(original.deleted_at);
 assert.equal(s.db.prepare('SELECT total_changes() n').get().n,changes);
});

test('quoted credentials and data are removed before truncation in display text',()=>{
 const preview=safeText('{"api_key":"private words", "access_token": "private token", "password":"private password"} Bearer private-bearer sk-private-key /home/private/x.png data:image/png;base64,privatedata');
 for(const secret of ['private words','private token','private password','private-bearer','private-key','/home/','privatedata'])assert.equal(preview.includes(secret),false,secret);
 assert.equal(preview.length<=240,true);
 const summary=taskSummary({blocks:[{type:'image',status:'ready',attachmentId:'not-a-valid-id'}]});assert.ok(summary.reasons.includes('IMAGE_RECEIVE_FAILED'));
});
