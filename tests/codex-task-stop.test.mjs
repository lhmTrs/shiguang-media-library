import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {codexRouter} from '../server/prompt-codex/router.mjs';
import {setup,start,emit,until,delay} from './codex-task-fixture.mjs';
const code=expected=>e=>e.code===expected;

test('three-task impact must explicitly confirm; old stop cannot bypass; interrupt ACK remains stopping',async t=>{
 const s=await setup(t);await s.service.connect();const tasks=[await start(s),await start(s),await start(s)],target=tasks[0];
 const impact=s.service.stopImpact(target.id);assert.equal(impact.requiresConfirmation,true);assert.equal(impact.otherTasks.length,2);
 await assert.rejects(s.service.stopTask(target.id,{}),code('STOP_IMPACT_REQUIRED'));
 await assert.rejects(s.service.stop(target.conversationId,target.id),code('STOP_CONFIRMATION_REQUIRED'));
 await assert.rejects(s.service.stopTask(target.id,{impactToken:impact.impactToken}),code('STOP_CONFIRMATION_REQUIRED'));
 assert.equal(s.fake.calls.filter(c=>c.method==='turn/interrupt').length,0);
 const reply=await s.service.stopTask(target.id,{impactToken:impact.impactToken,confirmSharedClose:true});
 assert.equal(reply.turns.find(t=>t.id===target.id).status,'stopping');assert.equal(s.fake.closes,0);
 await Promise.all(tasks.map(t=>t.work));assert.equal(s.fake.closes,1);
 assert.equal(s.store.getTurn(target.id).error_code,'USER_STOPPED');
 for(const other of tasks.slice(1)){assert.equal(s.store.getTurn(other.id).error_code,'SHARED_CONNECTION_CLOSED');assert.equal(s.store.getTurn(other.id).status,'interrupted');}
 const dto=s.service.taskOverview();assert.equal(dto.activeCount,0);assert.equal(dto.items.find(i=>i.taskId===target.id).phase,'stopped');assert.ok(dto.items.find(i=>i.taskId===tasks[1].id).attention.required);
});

test('new arrival before POST and after POST cannot be killed with stale approval',async t=>{
 const s=await setup(t);await s.service.connect();const first=await start(s),old=s.service.stopImpact(first.id),second=await start(s);
 await assert.rejects(s.service.stopTask(first.id,{impactToken:old.impactToken}),code('STOP_SCOPE_CHANGED'));assert.equal(s.fake.closes,0);
 const fresh=s.service.stopImpact(first.id);await s.service.stopTask(first.id,{impactToken:fresh.impactToken,confirmSharedClose:true});const third=await start(s);
 await until(()=>s.store.getTurn(first.id).error_code==='STOP_SCOPE_CHANGED');
 assert.equal(s.fake.closes,0);assert.equal(s.service.tasks.size,3);assert.equal(s.store.getTurn(third.id).status,'running');
 const renewal=s.service.stopImpact(first.id);await s.service.stopTask(first.id,{impactToken:renewal.impactToken,confirmSharedClose:true});await Promise.all([first.work,second.work,third.work]);assert.equal(s.fake.closes,1);
});

test('expiry and connection identity are checked both at submit and at delayed close',async t=>{
 const s=await setup(t);await s.service.connect();const task=await start(s),impact=s.service.stopImpact(task.id),grant=s.service.impactTokens.get(impact.impactToken);
 grant.expiresAt=Date.now()-1;await assert.rejects(s.service.stopTask(task.id,{impactToken:impact.impactToken}),code('STOP_SCOPE_EXPIRED'));
 const valid=s.service.stopImpact(task.id);await s.service.stopTask(task.id,{impactToken:valid.impactToken});s.service.impactTokens.get(valid.impactToken).expiresAt=Date.now()-1;
 await until(()=>s.store.getTurn(task.id).error_code==='STOP_SCOPE_EXPIRED');assert.equal(s.fake.closes,0);assert.equal(s.service.tasks.size,1);
 const again=s.service.stopImpact(task.id);const g=s.service.impactTokens.get(again.impactToken);g.client={};await assert.rejects(s.service.stopTask(task.id,{impactToken:again.impactToken}),code('STOP_SCOPE_CHANGED'));
});

test('completion is separate from ACK and single legacy stop keeps compatibility',async t=>{
 const s=await setup(t);await s.service.connect();s.fake.ackOnly=false;const task=await start(s);
 const impact=s.service.stopImpact(task.id);assert.equal(impact.requiresConfirmation,false);
 await s.service.stop(task.conversationId,task.id);await task.work;
 assert.equal(s.fake.closes,0);assert.equal(s.store.getTurn(task.id).status,'interrupted');assert.equal(s.store.getTurn(task.id).error_code,'USER_STOPPED');
});

test('unknown actual exit preserves ownership and blocks reconnect/admission, not a success',async t=>{
 const s=await setup(t);await s.service.connect();const task=await start(s);s.fake.rejectClose=true;
 const impact=s.service.stopImpact(task.id);await s.service.stopTask(task.id,{impactToken:impact.impactToken});
 await until(()=>s.store.getTurn(task.id).error_code==='CODEX_CLOSE_UNSETTLED');
 assert.equal(s.service.tasks.has(task.id),true);assert.equal(s.store.getTurn(task.id).status,'stopping');assert.equal(s.service.taskOverview().connection.unsettled,true);
 await assert.rejects(s.service.connect(),code('CODEX_BUSY'));
 await assert.rejects(s.service.start(task.conversationId,{id:'unused'}),code('CODEX_BUSY'));
 assert.notEqual(s.service.taskOverview().items[0].phase,'stopped');
 s.fake.rejectClose=false;await s.fake.close();await task.work;
});

test('a close method resolving without actual exit is unsettled, not terminal',async t=>{
 const s=await setup(t);await s.service.connect();const task=await start(s);s.fake.silentClose=true;
 await s.service.stopTask(task.id,{impactToken:s.service.stopImpact(task.id).impactToken});
 await until(()=>s.store.getTurn(task.id).error_code==='CODEX_CLOSE_UNSETTLED');assert.equal(s.service.tasks.size,1);assert.equal(s.store.getTurn(task.id).status,'stopping');
 s.fake.silentClose=false;await s.fake.close();await task.work;
});

test('error cleanup during user stop cannot bypass changed shared scope',async t=>{
 const s=await setup(t);await s.service.connect();const first=await start(s);await s.service.stopTask(first.id,{impactToken:s.service.stopImpact(first.id).impactToken});const next=await start(s);
 emit(s,first,'error',{willRetry:false});
 await until(()=>s.store.getTurn(first.id).error_code==='STOP_SCOPE_CHANGED');await delay(35);
 assert.equal(s.fake.closes,0);assert.equal(s.service.tasks.size,2);assert.equal(s.store.getTurn(next.id).status,'running');
 await s.service.stopTask(first.id,{impactToken:s.service.stopImpact(first.id).impactToken,confirmSharedClose:true});await Promise.all([first.work,next.work]);assert.equal(s.fake.closes,1);
});

test('admission is sealed before invoking a yielding/reentrant close',async t=>{
 const s=await setup(t);await s.service.connect();const task=await start(s);let rejected=false;
 s.fake.closeHook=async()=>{await assert.rejects(s.service.start(task.conversationId,{}),code('CODEX_BUSY'));rejected=true;};
 await s.service.stopTask(task.id,{impactToken:s.service.stopImpact(task.id).impactToken});await task.work;assert.equal(rejected,true);
});

test('forced safety stop remains effective even after a user stop',async t=>{
 const s=await setup(t);await s.service.connect();const first=await start(s);await s.service.stopTask(first.id,{impactToken:s.service.stopImpact(first.id).impactToken});const next=await start(s);
 emit(s,first,'item/completed',{item:{id:'forbidden',type:'commandExecution',command:'never executed'}});
 await Promise.all([first.work,next.work]);assert.equal(s.fake.closes,1);assert.equal(s.store.getTurn(first.id).error_code,'UNEXPECTED_TOOL_REQUEST');assert.equal(s.store.getTurn(first.id).status,'failed');
});

test('real HTTP old route cannot bypass impact; cross-task tokens refused; stop GET has no DB writes',async t=>{
 const s=await setup(t);await s.service.connect();const first=await start(s),second=await start(s);
 const app=express();app.use('/api/prompt-codex',codexRouter(s.store,s.service,s.media,{}));const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>server.close());const base='http://127.0.0.1:'+server.address().port+'/api/prompt-codex';
 const changes=s.db.prepare('SELECT total_changes() n').get().n;
 const impact=await(await fetch(base+'/tasks/'+first.id+'/stop-impact')).json();assert.equal(s.db.prepare('SELECT total_changes() n').get().n,changes);
 const post=(url,body)=>fetch(base+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const old=await post('/conversations/'+first.conversationId+'/turns/'+first.id+'/stop',{});assert.equal(old.status,409);assert.equal((await old.json()).code,'STOP_CONFIRMATION_REQUIRED');
 const crossed=await post('/tasks/'+second.id+'/stop',{impactToken:impact.impactToken,confirmSharedClose:true});assert.equal(crossed.status,409);assert.equal((await crossed.json()).code,'STOP_SCOPE_CHANGED');
 assert.equal(s.fake.closes,0);assert.equal(s.fake.calls.filter(c=>c.method==='turn/interrupt').length,0);
});
