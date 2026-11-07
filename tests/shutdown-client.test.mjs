import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import crypto from 'node:crypto';import {once} from 'node:events';
import {createShutdownClient} from '../scripts/shutdown-client.mjs';
const token='b'.repeat(64),cookie='media_session='+ 'c'.repeat(32),libraryId='mock-peer-library';
// These peers test the client protocol only. HMACs are mock attestations, not
// proof of the original App's resource closure. Module resource tests are separate.
async function peer(t,options={}){
 const runId=crypto.randomUUID(),requestId=crypto.randomUUID(),requests=[];
 const server=http.createServer(async(req,res)=>{
  requests.push({method:req.method,path:req.url});let body='';for await(const b of req)body+=b;
  res.setHeader('content-type','application/json');
  if(req.url==='/api/session'){
   if(options.redirect){res.writeHead(302,{location:'http://127.0.0.1:1/'});res.end();return;}
   res.setHeader('set-cookie',cookie+'; HttpOnly; SameSite=Strict');res.end(JSON.stringify({app:'shiguang-local-media',instanceId:libraryId,runId,token,...options.identity}));return;
  }
  if(req.url==='/api/application/shutdown'){
   assert.equal(req.method,'POST');assert.equal(req.headers.cookie,cookie);assert.equal(req.headers['x-local-token'],token);assert.equal(req.headers.origin,`http://127.0.0.1:${server.address().port}`);assert.deepEqual(JSON.parse(body),{runId,requestId});
   if(options.disconnect){req.socket.destroy();return;}
   res.statusCode=202;res.end(JSON.stringify({phase:'ACCEPTED',runId,requestId,...options.accepted}));return;
  }
  res.statusCode=404;res.end('{}');
 });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{await new Promise(r=>server.close(r));});
 return{runId,requestId,requests,command:{url:`http://127.0.0.1:${server.address().port}`,libraryId,runId,requestId}};
}
function signed(p,changes={}){
 const body={format:1,libraryId,runId:p.runId,requestId:p.requestId,phase:'CLOSED_KNOWN',expiresAt:Date.now()+1000,...changes};return{body,mac:crypto.createHmac('sha256',token).update(JSON.stringify(body)).digest('hex')};
}
console.log(JSON.stringify({evidence:'W04 new private HTTP mock peers; no original service/config files',pid:process.pid,host:process.platform,node:process.version}));

test('W04 client construction has zero IO, no receipt observer is unsupported before fetch',async()=>{
 let calls=0;const client=createShutdownClient({fetchImpl:async()=>{calls++;throw Error();}});assert.equal(calls,0);const result=await client.stop({url:'http://127.0.0.1:45123',libraryId,runId:crypto.randomUUID(),requestId:crypto.randomUUID()});assert.equal(result.phase,'UNSUPPORTED');assert.equal(calls,0);
});

test('W04 client strict loopback URL rejects cross host/query/hash/auth/path before IO',async()=>{
 let calls=0;for(const url of ['http://localhost:4317','http://127.1:4317','http://2130706433:4317','http://127.0.0.1:4317/a/..','http://127.0.0.1:4317/a','http://user@127.0.0.1:4317','http://127.0.0.1:4317/?x=1','http://127.0.0.1:4317/#x','https://127.0.0.1:4317','http://192.168.1.1:4317','http://127.0.0.1']){const c=createShutdownClient({fetchImpl:async()=>{calls++;},readReceipt:async()=>null});assert.equal((await c.stop({url,libraryId,runId:crypto.randomUUID(),requestId:crypto.randomUUID()})).phase,'UNKNOWN');}assert.equal(calls,0);
});

test('W04 real private peer: authenticated command once, same request idempotent, bound receipt required',async t=>{
 const p=await peer(t);let reads=0;const c=createShutdownClient({budgetMs:500,readReceipt:async()=>{reads++;return reads>1?signed(p):null;}});const first=c.stop(p.command);assert.equal(c.stop(p.command),first);assert.equal((await c.stop({...p.command,requestId:crypto.randomUUID()})).code,'SHUTDOWN_CONFLICT');assert.deepEqual(await first,{phase:'CLOSED_KNOWN',runId:p.runId,requestId:p.requestId});assert.equal(p.requests.filter(r=>r.method==='POST').length,1);
});

test('W04 wrong app/library/run/token or redirect never reaches shutdown POST',async t=>{
 for(const options of [{identity:{app:'other-app'}},{identity:{instanceId:'other-library'}},{identity:{runId:crypto.randomUUID()}},{identity:{token:'bad'}},{redirect:true}]){
  const p=await peer(t,options);const c=createShutdownClient({budgetMs:100,readReceipt:async()=>signed(p)});assert.deepEqual(await c.stop(p.command),{phase:'UNKNOWN',code:'SHUTDOWN_UNCONFIRMED'});assert.equal(p.requests.length,1);
 }
});

test('W04 valid HMAC of ACCEPTED/UNKNOWN or expired/old/wrong-request/forged receipt is not closure',async t=>{
 for(const kind of ['accepted','unknown','expired','old-run','other-request','forged','missing']){
  const p=await peer(t);let receipt=kind==='accepted'?signed(p,{phase:'ACCEPTED'}):kind==='unknown'?signed(p,{phase:'UNKNOWN'}):kind==='expired'?signed(p,{expiresAt:Date.now()-1}):kind==='old-run'?signed(p,{runId:crypto.randomUUID()}):kind==='other-request'?signed(p,{requestId:crypto.randomUUID()}):kind==='missing'?null:signed(p);if(kind==='forged')receipt.mac='0'.repeat(64);
  const c=createShutdownClient({budgetMs:40,pollMs:5,readReceipt:async()=>receipt});assert.deepEqual(await c.stop(p.command),{phase:'UNKNOWN',code:'SHUTDOWN_UNCONFIRMED'});
 }
});

test('W04 202 alone, disconnect and wrong accepted request remain UNKNOWN without leaking errors',async t=>{
 for(const options of [{},{disconnect:true},{accepted:{requestId:crypto.randomUUID()}}]){const p=await peer(t,options);const c=createShutdownClient({budgetMs:40,pollMs:5,readReceipt:async()=>null});assert.deepEqual(await c.stop(p.command),{phase:'UNKNOWN',code:'SHUTDOWN_UNCONFIRMED'});}
 const p=await peer(t);const c=createShutdownClient({readReceipt:async()=>{throw Error('PRIVATE PATH TOKEN '+token);},budgetMs:100});assert.deepEqual(await c.stop(p.command),{phase:'UNKNOWN',code:'SHUTDOWN_UNCONFIRMED'});
});

test('W04 client fixed budget also bounds a stuck receipt provider and never invokes process kill',async t=>{
 const p=await peer(t),c=createShutdownClient({budgetMs:35,readReceipt:()=>new Promise(()=>{})});const started=Date.now();assert.equal((await c.stop(p.command)).phase,'UNKNOWN');assert.ok(Date.now()-started<500);assert.equal(p.requests.filter(r=>r.method==='POST').length,1);
});

test('W04 R1 total budget rejects sync-blocked late receipt even if its HMAC is valid',async t=>{
 const p=await peer(t);const c=createShutdownClient({budgetMs:80,pollMs:5,readReceipt:()=>{const end=performance.now()+110;while(performance.now()<end){}return signed(p);}});
 assert.deepEqual(await c.stop(p.command),{phase:'UNKNOWN',code:'SHUTDOWN_UNCONFIRMED'});assert.equal(p.requests.filter(r=>r.method==='POST').length,1);
});

test('W04 R1 total budget is checked after receipt serialization/verification too',async t=>{
 const p=await peer(t);const receipt=signed(p);Object.defineProperty(receipt,'toJSON',{value:()=>{const end=performance.now()+110;while(performance.now()<end){}return{body:receipt.body,mac:receipt.mac};}});
 const c=createShutdownClient({budgetMs:80,pollMs:5,readReceipt:async()=>receipt});assert.deepEqual(await c.stop(p.command),{phase:'UNKNOWN',code:'SHUTDOWN_UNCONFIRMED'});
});
