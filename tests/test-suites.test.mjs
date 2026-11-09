import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {selectTests, runTestFile, DEFAULT_TIMEOUT_MS} from '../scripts/test-suites.mjs';
const exec = promisify(execFile);
async function scene(t) { const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-test-suites-'))); t.after(()=>fs.rm(root,{recursive:true,force:true})); return root; }

test('suite selection excludes every cloud file and enrollment, retains local files, no UI selection', async t => {
  const root = await scene(t);
  for (const f of ['tags.test.mjs','cloud-upload-lifecycle.test.mjs','cloud-new.test.mjs','device-enrollment.test.mjs','cloud-other-ui.mjs','ordinary-ui.mjs']) await fs.writeFile(path.join(root,f),'throw Error("must not execute when listing")');
  await fs.mkdir(path.join(root,'not-a-file.test.mjs'));
  assert.deepEqual((await selectTests('local',root)).included,['tags.test.mjs']);
  assert.deepEqual((await selectTests('cloud',root)).included,['cloud-new.test.mjs','cloud-upload-lifecycle.test.mjs','device-enrollment.test.mjs']);
  await assert.rejects(selectTests('unknown',root));
  assert.equal(DEFAULT_TIMEOUT_MS,120000);
});

test('CLI list is deterministic and an explicit cloud file cannot enter the local suite', async () => {
  const {stdout} = await exec(process.execPath,['scripts/test-suites.mjs','--list']);
  const selected = JSON.parse(stdout);
  assert.ok(selected.included.includes('tags.test.mjs'));
  assert.ok(selected.excluded.includes('device-enrollment.test.mjs'));
  assert.equal(selected.included.some(n=>n.startsWith('cloud-')),false);
  await assert.rejects(exec(process.execPath,['scripts/test-suites.mjs','--file','cloud-upload-lifecycle.test.mjs','--list']),e=>e.code===1 && /Not in local suite/.test(e.stderr));
  await assert.rejects(exec(process.execPath,['scripts/test-suites.mjs','--timeout','NaN','--list']));
});

test('a real success and real assertion failure retain their raw exit result', async t => {
  const root = await scene(t), good = path.join(root,'good.test.mjs'), bad = path.join(root,'bad.test.mjs');
  await fs.writeFile(good,`import test from 'node:test';test('ok',()=>{});`);
  await fs.writeFile(bad,`import test from 'node:test';test('bad',()=>{throw Error('expected fixture failure')});`);
  const pass = await runTestFile(good,{cwd:root,timeoutMs:5000,output:()=>{}});
  assert.equal(pass.passed,true,JSON.stringify(pass)); assert.equal(pass.rawExit.code,0); assert.equal(pass.resourcesKnown,true);
  const fail = await runTestFile(bad,{cwd:root,timeoutMs:5000,output:()=>{}});
  assert.equal(fail.passed,false); assert.equal(fail.rawExit.code,1); assert.equal(fail.timedOut,false); assert.equal(fail.resourcesKnown,true);
});

test('a hanging server and descendant are bounded and actually close after normal stop', {skip:process.platform==='win32' ? 'POSIX process-group qualification only' : false}, async t => {
  const root = await scene(t), fixture = path.join(root,'hang.test.mjs'), receipt=path.join(root,'closed.json');
  await fs.writeFile(path.join(root,'server.mjs'),`import http from 'node:http';import fs from 'node:fs';const s=http.createServer((q,r)=>r.end('fixture'));s.listen(0,'127.0.0.1',()=>fs.writeFileSync('started.json',JSON.stringify({pid:process.pid,port:s.address().port})));process.on('SIGTERM',()=>s.close(()=>{fs.writeFileSync('closed.json',JSON.stringify({closed:true,pid:process.pid}));process.exitCode=0;}));`);
  await fs.writeFile(fixture,`import test from 'node:test';import{spawn}from'node:child_process';test('hang with synthetic descendant',async()=>{spawn(process.execPath,['server.mjs'],{stdio:'inherit'});await new Promise(()=>{});});`);
  const result = await runTestFile(fixture,{cwd:root,timeoutMs:1500,graceMs:3000,output:()=>{}});
  assert.equal(result.passed,false); assert.equal(result.timedOut,true,JSON.stringify(result)); assert.ok(result.durationMs<5000);
  assert.equal(result.resourcesKnown,true,JSON.stringify(result)); assert.equal(result.groupAbsent,true);
  const started = JSON.parse(await fs.readFile(path.join(root,'started.json'),'utf8'));
  assert.equal(JSON.parse(await fs.readFile(receipt,'utf8')).pid,started.pid);
  assert.throws(()=>process.kill(started.pid,0),{code:'ESRCH'});
  const server=net.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(started.port,'127.0.0.1',resolve);});await new Promise(r=>server.close(r));
});
