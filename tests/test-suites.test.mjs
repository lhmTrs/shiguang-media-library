import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {selectTests, runTestFile, DEFAULT_TIMEOUT_MS} from '../scripts/test-suites.mjs';
const exec = promisify(execFile);
const repo = fileURLToPath(new URL('..', import.meta.url));
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

test('observed normal children and original spawn errors keep real semantics and a clean resource result', async t => {
  const root = await scene(t), file = path.join(root, 'clean-child.test.mjs'), marker = path.join(root, 'detached-ran');
  await fs.writeFile(file, `import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import fs from 'node:fs/promises';
test('real children',async()=>{
 const child=spawn(process.execPath,['-e','process.exitCode=17'],{stdio:'ignore'});
 assert.equal(child.listenerCount('error'),0,'observer must not add an error listener');
 const result=await new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
 assert.deepEqual(result,{code:17,signal:null});
 const detached=spawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran');process.exitCode=23;`)}],{detached:true,stdio:'ignore'});
 detached.unref();
 let ready=false;for(let i=0;i<200;i++){try{await fs.access(${JSON.stringify(marker)});ready=true;break;}catch{await new Promise(resolve=>setTimeout(resolve,10));}}
 assert.equal(ready,true);
 const missing=spawn('shiguang-intentionally-absent-executable',[],{stdio:'ignore'});
 assert.equal(missing.listenerCount('error'),0);
 await new Promise(resolve=>missing.once('error',error=>{assert.equal(error.code,'ENOENT');resolve();}));
});`);
  const result = await runTestFile(file, {cwd:root, timeoutMs:3000, graceMs:500, output:()=>{}});
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.resourcesKnown, true);
  assert.deepEqual(result.rawExit, {code:0, signal:null});
  assert.ok(result.resourceObservation.processes.some(child => child.rawExit?.code === 17));
  assert.ok(result.resourceObservation.processes.some(child => child.detached === true && child.rawExit?.code === 23));
  t.diagnostic(JSON.stringify(result));
});

test('published test runner includes both actual observation dependencies', async () => {
  const {shareFiles, collectFiles} = await import('../scripts/package.mjs');
  for (const file of ['scripts/test-resource-ledger.cjs', 'scripts/test-resource-observer.cjs']) {
    assert.ok(shareFiles.includes(file), `missing shipped runner dependency: ${file}`);
    assert.deepEqual(await collectFiles(repo, file), [file]);
  }
});

test('synchronous Node children keep their real status, stdout and execFileSync exception', async t => {
  const root = await scene(t), file = path.join(root, 'sync-node.test.mjs');
  await fs.writeFile(file, `import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync,execFileSync} from 'node:child_process';
test('normal sync Node',()=>{
 const result=spawnSync(process.execPath,['-e','process.stdout.write("SYNC_OK");process.exitCode=17'],{encoding:'utf8'});
 assert.equal(result.status,17);assert.equal(result.signal,null);assert.equal(result.stdout,'SYNC_OK');
 assert.equal(execFileSync(process.execPath,['-e','process.stdout.write("EXEC_OK")'],{encoding:'utf8'}),'EXEC_OK');
 assert.throws(()=>execFileSync(process.execPath,['-e','process.exitCode=19']),error=>error.status===19&&error.signal===null);
});`);
  const result = await runTestFile(file, {cwd:root, timeoutMs:3000, graceMs:500, output:()=>{}});
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.deepEqual(result.rawExit, {code:0, signal:null});
  for (const code of [17, 0, 19]) assert.ok(result.resourceObservation.observedChildren.some(child => child.sync && child.nodeObserver && child.rawExit?.code === code));
  t.diagnostic(JSON.stringify(result));
});

test('an isolated synthetic App explicitly inherits only the runner observation context and closes normally', {skip:process.platform==='win32'}, async t => {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/sg-i6-app-'));
  const file = path.join(root, 'minimal-app.test.mjs'), stateFile = path.join(root, 'state.json'), closedFile = path.join(root, 'closed.json');
  const server = path.join(repo, 'tests/fixtures/test-runner-detached-server.mjs');
  t.after(async () => {
    const closed = await fs.readFile(closedFile, 'utf8').then(JSON.parse, () => null);
    if (closed?.code === 0 && closed.signal === null) await fs.rm(root, {recursive:true});
    else t.diagnostic(`Unconfirmed synthetic App preserved at ${root}`);
  });
  await fs.writeFile(file, `import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import net from 'node:net';import {spawn} from 'node:child_process';import {inheritTestObservation} from ${JSON.stringify(path.join(repo, 'scripts/test-suites.mjs'))};
test('minimal isolated App',async()=>{
 const env=inheritTestObservation({PATH:process.env.PATH,MEDIA_DATA_DIR:${JSON.stringify(path.join(root, 'private-data'))},MEDIA_SKIP_IMPORT:'1'});
 assert.equal(env.HOME,undefined);assert.equal(env.NODE_TEST_CONTEXT,undefined);assert.ok(env.SHIGUANG_TEST_RESOURCE_RUNS);
 const child=spawn(process.execPath,[${JSON.stringify(server)},${JSON.stringify(stateFile)},${JSON.stringify(path.join(root, 'control.sock'))}],{env,stdio:'ignore'});
 const exit=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));let state;
 try{
  for(let i=0;i<200;i++){try{state=JSON.parse(await fs.readFile(${JSON.stringify(stateFile)},'utf8'));break;}catch{await new Promise(resolve=>setTimeout(resolve,10));}}
  assert.ok(state);const response=await fetch('http://127.0.0.1:'+state.port);assert.equal(response.status,200);assert.equal(await response.text(),'OWNED_FIXTURE');
 }finally{
  if(state)await new Promise((resolve,reject)=>{const socket=net.connect(state.controlPath);socket.once('connect',()=>socket.end('EXIT'));socket.on('data',()=>{});socket.once('error',reject);socket.once('close',resolve);});
 }
 const result=await exit;assert.deepEqual(result,{code:0,signal:null});
 const events=(await fs.readFile(${JSON.stringify(stateFile+'.events')},'utf8')).trim().split('\\n').map(JSON.parse);
 assert.ok(events.some(event=>event.event==='http-closed'));assert.ok(events.some(event=>event.event==='exit'&&event.code===0));
 await fs.writeFile(${JSON.stringify(closedFile)},JSON.stringify({...result,events}));
});`);
  const result = await runTestFile(file, {cwd:root, timeoutMs:3000, graceMs:500, output:()=>{}});
  assert.equal(result.passed, true, JSON.stringify(result));
  const closed = JSON.parse(await fs.readFile(closedFile, 'utf8'));
  assert.deepEqual({code:closed.code, signal:closed.signal}, {code:0, signal:null});
  t.diagnostic(JSON.stringify({result, isolatedApp:closed}));
});
