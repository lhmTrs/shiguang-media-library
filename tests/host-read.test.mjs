import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
const source=await fs.readFile(new URL('../src/host-read.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {createHostReadClient}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const busy=()=>Response.json({error:'HOST_BUSY',code:'HOST_BUSY'},{status:423});

test('a local GET recovers without consuming the returned body, and stays active throughout backoff',async()=>{
 let attempts=0,time=10000,client;const observations=[];
 client=createHostReadClient({now:()=>time,fetch:async()=>++attempts<3?busy():Response.json({items:['confirmed']}),wait:async ms=>{observations.push({recovering:client.recovering(),idle:client.idle()});time+=ms;}});
 const states=[];client.subscribe(()=>states.push(client.recovering()));
 assert.deepEqual(await(await client.fetch('/api/assets')).json(),{items:['confirmed']});
 assert.equal(attempts,3);assert.deepEqual(states,[true,false]);assert.ok(observations.every(o=>o.recovering&&!o.idle));assert.equal(client.idle(),false);time+=2000;assert.equal(client.idle(),true);
});

test('writes, foreign URLs, unrelated refusals and network errors never replay',async()=>{
 for(const [url,method,response] of [
  ...['POST','PUT','PATCH','DELETE'].map(method=>['/api/assets',method,busy]),
  ['https://other.invalid/api/assets','GET',busy],['//other.invalid/api/assets','GET',busy],
  ['/api/assets','GET',()=>Response.json({error:'HOST_BUSY'},{status:423})],
  ['/api/assets','GET',()=>Response.json({code:'HOST_CLOSED'},{status:423})],
  ['/api/assets','GET',()=>Response.json({code:'HOST_BUSY'},{status:500})],
  ['/api/assets','GET',()=>new Response('not-json',{status:423})],
 ]){let calls=0;const c=createHostReadClient({fetch:async()=>{calls++;return response();},wait:async()=>assert.fail('unexpected retry')});const r=await c.fetch(url,{method});await r.text();assert.equal(calls,1,url+' '+method);assert.equal(c.recovering(),false);}
 let calls=0;const c=createHostReadClient({fetch:async()=>{calls++;throw Error('network');}});await assert.rejects(()=>c.fetch('/api/assets'),/network/);assert.equal(calls,1);
});

test('persistent HOST_BUSY stops within nine attempts and the original 15-second budget',async()=>{
 let calls=0,time=1000,waited=0;const c=createHostReadClient({now:()=>time,fetch:async()=>{calls++;return busy();},wait:async ms=>{time+=ms;waited+=ms;}});
 await assert.rejects(()=>c.fetch('/api/assets'),e=>e.code==='HOST_BUSY'&&e.status===423&&/维护/.test(e.message));assert.equal(calls,9);assert.ok(waited<=15000);assert.equal(c.recovering(),false);time+=2000;assert.equal(c.idle(),true);
 let slowCalls=0,slowTime=0;const slow=createHostReadClient({now:()=>slowTime,fetch:async()=>{slowCalls++;slowTime+=7000;return busy();},wait:async ms=>{slowTime+=ms;}});await assert.rejects(()=>slow.fetch('/api/assets'),{code:'HOST_BUSY'});assert.equal(slowCalls,3,'elapsed request time counts too');
});

test('cancel before send, during request and during backoff releases activity without another attempt',async()=>{
 const before=new AbortController();before.abort();let calls=0;const first=createHostReadClient({fetch:async()=>{calls++;return busy();}});await assert.rejects(()=>first.fetch('/api/assets',{signal:before.signal}),{name:'AbortError'});assert.equal(calls,0);
 const during=new AbortController();let sent;const entered=new Promise(r=>sent=r);const second=createHostReadClient({fetch:async(_url,init)=>{sent();return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));}});const active=second.fetch('/api/assets',{signal:during.signal});await entered;assert.equal(second.idle(0),false);during.abort();await assert.rejects(()=>active,{name:'AbortError'});assert.equal(second.idle(0),true);
 const waiting=new AbortController();let waitingCalls=0,blocked;const waitEntered=new Promise(r=>blocked=r);const third=createHostReadClient({fetch:async()=>{waitingCalls++;return busy();},wait:(ms,signal)=>{blocked();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});const retry=third.fetch('/api/assets',{signal:waiting.signal});await waitEntered;assert.equal(third.recovering(),true);waiting.abort();await assert.rejects(()=>retry,{name:'AbortError'});assert.equal(waitingCalls,1);assert.equal(third.recovering(),false);assert.equal(third.idle(0),true);
});

test('one completed read cannot release another pending read, and caller decoding stays tracked',async()=>{
 let release;const held=new Promise(r=>release=r);const c=createHostReadClient({fetch:async url=>{if(url==='/api/roots')await held;return Response.json({ok:true});}});
 const roots=c.fetch('/api/roots');await c.fetch('/api/assets');assert.equal(c.idle(0),false);release();await roots;assert.equal(c.idle(0),true);
 let finish;const decode=new Promise(r=>finish=r);const work=c.track(async()=>{await c.fetch('/api/assets');await decode;});await new Promise(r=>setTimeout(r,0));assert.equal(c.idle(0),false);finish();await work;assert.equal(c.idle(0),true);
});

test('body arrival remains an active read and cancellation stops body waiting',async()=>{
 let stream,client;const response=new Response(new ReadableStream({start(c){stream=c;}}),{headers:{'content-type':'application/json'}});
 client=createHostReadClient({fetch:async()=>response});let resolved=false;const read=client.fetch('/api/assets').then(r=>{resolved=true;return r;});await new Promise(r=>setTimeout(r,5));assert.equal(resolved,false);assert.equal(client.idle(0),false);stream.enqueue(new TextEncoder().encode('{"ok":true}'));stream.close();assert.deepEqual(await(await read).json(),{ok:true});assert.equal(client.idle(0),true);
 const ac=new AbortController();const stalled=createHostReadClient({fetch:async()=>new Response(new ReadableStream({start(){}}))});const pending=stalled.fetch('/api/assets',{signal:ac.signal});await new Promise(r=>setTimeout(r,0));ac.abort();await assert.rejects(()=>pending,{name:'AbortError'});assert.equal(stalled.idle(0),true);
});

test('recovery checks identity before re-reading and before returning the completed body',async()=>{
 let calls=0,guards=0;const client=createHostReadClient({fetch:async()=>++calls===1?busy():Response.json({items:['original']}),wait:async()=>{}});
 assert.deepEqual(await(await client.fetch('/api/assets',{},async()=>{guards++;})).json(),{items:['original']});assert.equal(guards,2);
 let changedCalls=0;const changed=createHostReadClient({fetch:async()=>{changedCalls++;return busy();},wait:async()=>{}});await assert.rejects(()=>changed.fetch('/api/assets',{},async()=>{throw Object.assign(Error('changed'),{code:'LOCAL_INSTANCE_CHANGED'});}),{code:'LOCAL_INSTANCE_CHANGED'});assert.equal(changedCalls,1);assert.equal(changed.recovering(),false);assert.equal(changed.idle(0),true);
});
