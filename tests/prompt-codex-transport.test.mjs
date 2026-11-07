import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {CodexTransport} from '../server/prompt-codex/transport.mjs';

test('Real stdio framing/initialization/RPC errors and known subprocess exit, without a model service',async t=>{
 const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'codex-rpc-')),client=new CodexTransport({cwd,command:process.execPath,args:[path.join(import.meta.dirname,'helpers/fake-codex.mjs')],timeoutMs:1000});
 t.after(async()=>{await client.close();await fs.rm(cwd,{recursive:true,force:true});});await client.start();const auth=await client.call('account/read',{refreshToken:false});assert.equal(auth.account.type,'chatgpt');const models=await client.call('model/list',{});assert.equal(models.data.length,2);
 await assert.rejects(client.call('not/implemented',{}),e=>e.code==='CODEX_RPC_ERROR'&&!e.message.includes('synthetic unsupported'));
 await client.close();assert.ok(client.child.exitCode!==null||client.child.signalCode!==null);assert.equal(client.closed,true);
});
test('Unsolicited permissions, commands and unsupported server requests never receive approval',()=>{
 const client=new CodexTransport(),packets=[];client.closed=false;client.child={stdin:{writable:true,write:line=>packets.push(JSON.parse(line))}};
 for(const method of ['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','item/tool/call','account/chatgptAuthTokens/refresh'])client.receive(JSON.stringify({id:method,method,params:{}})+'\n');
 assert.equal(packets[0].result.decision,'decline');assert.equal(packets[1].result.decision,'decline');assert.deepEqual(packets[2].result.permissions,{});assert.equal(packets[3].result.success,false);assert.equal(packets[4].error.code,-32601);
});
test('Missing executable fails and closes without leaving an unobserved process',async()=>{
 const client=new CodexTransport({command:'/nonexistent/shiguang-codex-binary',timeoutMs:1000});await assert.rejects(client.start(),e=>e.code==='CODEX_START_FAILED');await client.close();assert.equal(client.closed,true);
});
