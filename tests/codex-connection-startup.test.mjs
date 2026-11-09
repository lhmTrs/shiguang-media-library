import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {CodexService} from '../server/prompt-codex/service.mjs';
import {CodexTransport,connectionFailure} from '../server/prompt-codex/transport.mjs';
import {ConciergeService} from '../server/concierge/service.mjs';
import {ConciergeTransport} from '../server/concierge/transport.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(r=>setImmediate(r));
class Catalog extends EventEmitter {
  constructor(world){super();this.world=world;this.closed=true;world.clients.push(this);}
  async start(){if(!this.closed)return;this.closed=false;this.world.starts++;await this.world.wait?.promise;}
  async call(method){
    assert.equal(this.closed,false);this.world.calls.push(method);
    if(this.world.failure)throw Object.assign(Error('private raw diagnostic must not be exposed'),{code:this.world.failure});
    if(method==='account/read')return{account:this.world.loggedIn?{type:'chatgpt'}:null,requiresOpenaiAuth:true};
    if(method==='model/list')return{data:[{model:'synthetic',displayName:'合成模型',isDefault:true,inputModalities:['text'],supportedReasoningEfforts:[]}],nextCursor:null};
    throw Error('Unexpected generation or thread method: '+method);
  }
  async close(){if(this.closed)return;this.closed=true;this.emit('closed',{});}
}
async function setup(t,kind,options={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'shiguang-connection-startup-'));
  const world={clients:[],calls:[],starts:0,loggedIn:true,...options.world};
  const factory=options.transportFactory||(()=>new Catalog(world));
  const service=kind==='templates'
    ?new CodexService({lib:{migrating:false}},{work:root,init:options.mediaInit||(async()=>{})},{transportFactory:factory})
    :new ConciergeService({tasks:()=>[]},{close:async()=>{}},{},{root,transportFactory:factory});
  t.after(async()=>{await service.close();await fs.rm(root,{recursive:true,force:true});});
  return{service,world,root};
}

for(const kind of ['templates','concierge']){
  test(kind+': startup is nonblocking and coalesced; status reads never start threads or reconnect',async t=>{
    const wait=deferred(),s=await setup(t,kind,{world:{wait}});
    const a=s.service.startConnection(),b=s.service.startConnection();await tick();
    assert.equal(s.service.status().connecting,true);assert.equal(s.world.starts,1);
    for(let i=0;i<12;i++)s.service.status();
    assert.equal(s.world.starts,1);assert.deepEqual(s.world.calls,[]);
    wait.resolve();const [first,second]=await Promise.all([a,b]);
    assert.equal(first.connected,true);assert.equal(second.connecting,false);assert.equal(second.connectionAttempted,true);
    await s.service.startConnection();assert.deepEqual(s.world.calls,['account/read','model/list']);
    assert.equal(s.service.status().connectionError,'');
  });
  test(kind+': failed startup is retained until one explicit manual retry',async t=>{
    const s=await setup(t,kind,{world:{failure:'CODEX_RPC_TIMEOUT'}});
    const failed=await s.service.startConnection();assert.equal(failed.connecting,false);assert.equal(failed.connected,false);
    assert.equal(failed.connectionErrorCode,'CODEX_RPC_TIMEOUT');assert.ok(!failed.connectionError.includes('private'));
    for(let i=0;i<8;i++){s.service.status();await s.service.startConnection();}
    assert.equal(s.world.starts,1);s.world.failure=null;
    const connected=await s.service.connect();assert.equal(connected.authenticated,true);assert.equal(connected.connecting,false);assert.equal(s.world.starts,2);
    assert.equal(connected.connectionError,'');assert.equal((await s.service.startConnection()).connected,true);assert.equal(s.world.starts,2);
  });
  test(kind+': missing login and a later disconnect never trigger automatic retry',async t=>{
    const s=await setup(t,kind,{world:{loggedIn:false}});
    const login=await s.service.startConnection();assert.equal(login.connected,true);assert.equal(login.authenticated,false);assert.deepEqual(login.models,[]);
    await s.service.startConnection();assert.deepEqual(s.world.calls,['account/read']);
    s.world.loggedIn=true;await s.service.connect();assert.equal(s.service.status().authenticated,true);
    await s.world.clients.at(-1).close();const count=s.world.starts,calls=s.world.calls.length;
    for(let i=0;i<5;i++){assert.equal(s.service.status().connected,false);await s.service.startConnection();}
    assert.equal(s.world.starts,count);assert.equal(s.world.calls.length,calls);assert.equal(s.service.status().connectionErrorCode,'CODEX_DISCONNECTED');
  });
  test(kind+': concurrent manual requests join the initial attempt rather than replacing it',async t=>{
    const wait=deferred(),s=await setup(t,kind,{world:{wait}});
    const initial=s.service.startConnection();await tick();const manual=s.service.connect();wait.resolve();
    await Promise.all([initial,manual]);assert.equal(s.world.starts,1);assert.deepEqual(s.world.calls,['account/read','model/list']);
  });
  test(kind+': application close settles a real owned synthetic child during initialization',async t=>{
    let client;
    const s=await setup(t,kind,{transportFactory:options=>client=new CodexTransport({cwd:typeof options==='string'?options:options.cwd,command:process.execPath,args:['-e',"const r=require('readline').createInterface({input:process.stdin});r.on('line',()=>{});r.on('close',()=>{process.exitCode=0;});"],timeoutMs:2000})});
    const initial=s.service.startConnection();for(let i=0;i<100&&!client?.child?.pid;i++)await tick();
    assert.ok(client?.child?.pid,'synthetic child must have actually started');
    await s.service.close();await initial;assert.equal(client.child.exitCode,0);assert.equal(client.closed,true);assert.equal(s.service.status().connecting,false);
    assert.equal(s.service.status().connected,false);
  });
}

test('Closing before media initialization finishes prevents late client allocation',async t=>{
  const gate=deferred(),s=await setup(t,'templates',{mediaInit:()=>gate.promise});
  const initial=s.service.startConnection();await tick();const stopped=s.service.close();gate.resolve();
  await Promise.all([initial,stopped]);assert.equal(s.world.starts,0);assert.equal(s.world.clients.length,0);
});
test('Both native transport types refuse a late spawn after close during binary lookup',async t=>{
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'shiguang-no-late-codex-'));t.after(()=>fs.rm(cwd,{recursive:true,force:true}));
  for(const Type of [CodexTransport,ConciergeTransport]){
    let spawns=0;const client=new Type({cwd,command:process.execPath,spawnImpl:()=>{spawns++;throw Error('must never spawn');}});
    const starting=client.start();await client.close();await assert.rejects(starting,e=>e.code==='CODEX_CLOSING');assert.equal(spawns,0);
  }
});
test('Manual reconnect retains active task and unsettled resource guards',async t=>{
  const a=await setup(t,'templates');await a.service.startConnection();const original=a.service.client;
  a.service.tasks.set('active',{});await assert.rejects(a.service.connect(),e=>e.status===409);assert.equal(a.service.client,original);assert.equal(original.closed,false);a.service.tasks.clear();
  a.service.transportUnsettled=true;await assert.rejects(a.service.connect(),e=>e.code==='CODEX_BUSY');a.service.transportUnsettled=false;
  const b=await setup(t,'concierge');await b.service.startConnection();const catalog=b.service.catalogClient;catalog.retirementError=true;
  await assert.rejects(b.service.connect(),e=>e.code==='CODEX_CLOSE_UNSETTLED');assert.equal(b.service.catalogClient,catalog);catalog.retirementError=false;
});
test('Connection status diagnostics redact unknown raw failures',()=>{
  const result=connectionFailure(Object.assign(Error('private-token-and-path'),{code:'RAW_SQL_AND_SECRET'}));
  assert.equal(result.code,'CODEX_CONNECTION_FAILED');assert.ok(!JSON.stringify(result).includes('private-token'));assert.ok(!JSON.stringify(result).includes('RAW_SQL'));
});
