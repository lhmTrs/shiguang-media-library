// Explicit qualification cases deliberately create UNKNOWN observation chains.
// They run outside the ordinary observed suite, and close owned HTTP via IPC.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {runTestFile} from '../../scripts/test-suites.mjs';
const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../..', import.meta.url));
async function scene(t) { const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'sg-test-suites-'))); t.after(()=>fs.rm(root,{recursive:true,force:true})); return root; }

async function poll(read, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw Error('owned fixture did not settle within its cleanup budget');
}

async function detachedScene(t, {isolated = false} = {}) {
  // Short, unique IPC path; never discover or clean another run's resources.
  const root = await fs.realpath(await fs.mkdtemp('/tmp/sg-i6-rework-'));
  const stateFile = path.join(root, 'server.json'), controlPath = path.join(root, 'control.sock');
  const file = path.join(root, 'detached.test.mjs');
  const server = path.join(repo, 'tests/fixtures/test-runner-detached-server.mjs');
  const text = `import test from 'node:test';import {spawn} from 'node:child_process';import fs from 'node:fs/promises';
test('owned detached HTTP descendant', async()=>{
  const child=spawn(process.execPath,[${JSON.stringify(server)},${JSON.stringify(stateFile)},${JSON.stringify(controlPath)}],
    {detached:true,stdio:'ignore',env:${isolated ? '{PATH:process.env.PATH}' : '{...process.env}'}});
  child.unref();
  for(let i=0;i<200;i++){try{await fs.access(${JSON.stringify(stateFile)});return;}catch{await new Promise(r=>setTimeout(r,10));}}
  throw Error('owned server never became ready');
});`;
  await fs.writeFile(file, text);
  t.after(async () => {
    let state;
    try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')); }
    catch { t.diagnostic(`Unconfirmed fixture preserved at ${root}`); return; }
    // IPC is the fixture's voluntary shutdown protocol. No kill or PID guess.
    await new Promise((resolve, reject) => {
      const socket = net.connect(state.controlPath);
      socket.setTimeout(2000, () => { socket.end(); reject(Error('owned control close deadline')); });
      socket.once('connect', () => socket.end('EXIT'));
      socket.on('data', () => {});
      socket.once('error', reject); socket.once('close', resolve);
    });
    const events = await poll(async () => {
      const rows = (await fs.readFile(`${stateFile}.events`, 'utf8')).trim().split('\n').map(JSON.parse);
      return rows.some(row => row.event === 'exit' && row.code === 0) ? rows : null;
    });
    assert.ok(events.some(row => row.event === 'http-closed'));
    assert.ok(events.some(row => row.event === 'control-closed'));
    const portClosed = await new Promise(resolve => {
      const socket = net.connect({host:'127.0.0.1', port:state.port});
      socket.once('connect', () => { socket.end(); resolve(false); });
      socket.once('error', error => resolve(error.code === 'ECONNREFUSED'));
    });
    assert.equal(portClosed, true);
    t.diagnostic(JSON.stringify({fixture:state, voluntaryCleanup:events, portClosed}));
    await fs.rm(root, {recursive:true});
  });
  return {root, file, text, readState:async () => JSON.parse(await fs.readFile(stateFile, 'utf8'))};
}

test('detached HTTP descendants remain UNKNOWN after the root/group exit, including isolated environments', {skip:process.platform==='win32'}, async t => {
  for (const isolated of [false, true]) await t.test(isolated ? 'explicit environment stays isolated' : 'inherited preload observes the escaped descendant', async t => {
    const scene = await detachedScene(t, {isolated});
    const result = await runTestFile(scene.file, {cwd:scene.root, timeoutMs:3000, graceMs:500, output:()=>{}});
    const state = await scene.readState();
    assert.deepEqual(result.rawExit, {code:0, signal:null});
    assert.equal(result.groupAbsent, true);
    assert.equal(result.timedOut, false);
    assert.equal(result.stopRequested, false);
    assert.equal(result.resourcesKnown, false);
    assert.equal(result.passed, false);
    const response = await fetch(`http://127.0.0.1:${state.port}`);
    assert.equal(response.status, 200); assert.equal(await response.text(), 'OWNED_FIXTURE');
    if (isolated) assert.ok(result.resourceObservation.unknown.some(item => item.reason === 'CHILD_OBSERVER_NOT_INHERITED'));
    else assert.ok(result.resourceObservation.processes.some(item => item.pid === state.pid && item.detached === true && item.rawExit === null));
    t.diagnostic(JSON.stringify({result, aliveHttpAfterReturn:200, fixture:state}));
  });
});

test('the CLI stops before the next file when a detached descendant is still serving HTTP', {skip:process.platform==='win32'}, async t => {
  const scene = await detachedScene(t), mini = path.join(scene.root, 'mini');
  await fs.mkdir(path.join(mini, 'scripts'), {recursive:true});
  await fs.mkdir(path.join(mini, 'tests'));
  for (const name of ['test-suites.mjs', 'test-resource-ledger.cjs', 'test-resource-observer.cjs']) {
    await fs.copyFile(path.join(repo, 'scripts', name), path.join(mini, 'scripts', name));
  }
  // A completed external tool must not mask the actually live Node descendant.
  await fs.writeFile(path.join(mini, 'tests/a-detached.test.mjs'), `import {execFileSync} from 'node:child_process';execFileSync('/usr/bin/true');\n` + scene.text);
  const sentinel = path.join(mini, 'must-not-run');
  await fs.writeFile(path.join(mini, 'tests/b-later.test.mjs'), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(sentinel)},'BAD');`);
  // NODE_TEST_CONTEXT must not turn this CLI invocation into an outer test worker.
  const env = {...process.env}; delete env.NODE_TEST_CONTEXT;
  const execution = await exec(process.execPath, ['scripts/test-suites.mjs', '--timeout', '3000'], {cwd:mini, env})
    .then(value => ({...value, code:0}), error => ({stdout:error.stdout, stderr:error.stderr, code:error.code, signal:error.signal}));
  assert.equal(execution.code, 1, JSON.stringify(execution));
  const line = execution.stdout.split('\n').find(line => line.startsWith('[test-file-result] '));
  assert.ok(line, execution.stdout);
  const result = JSON.parse(line.slice('[test-file-result] '.length));
  assert.equal(result.resourcesKnown, false); assert.equal(result.passed, false);
  assert.equal(result.observedResourcesClosed, false);
  assert.equal(result.resourceObservation.state, 'UNKNOWN');
  assert.ok(result.resourceObservation.limitations.some(item => item.reason === 'EXTERNAL_DESCENDANTS_NOT_OBSERVED'));
  assert.deepEqual(result.rawExit, {code:0, signal:null});
  assert.equal(await fs.access(sentinel).then(()=>true,()=>false), false);
  const state = await scene.readState();
  const response = await fetch(`http://127.0.0.1:${state.port}`);
  assert.equal(response.status, 200); await response.text();
  t.diagnostic(JSON.stringify({execution, result, sentinelNotRun:true, aliveHttpAfterReturn:200}));
});

test('an unqualified synchronous isolated spawn still really executes and is conservatively UNKNOWN', async t => {
  const root = await scene(t), marker = path.join(root, 'really-ran'), file = path.join(root, 'sync.test.mjs');
  await fs.writeFile(file, `import test from 'node:test';import {execFileSync} from 'node:child_process';
test('real sync spawn',()=>execFileSync(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(marker)},'YES')`)}],{env:{PATH:process.env.PATH}}));`);
  const result = await runTestFile(file, {cwd:root, timeoutMs:3000, graceMs:500, output:()=>{}});
  assert.deepEqual(result.rawExit, {code:0, signal:null});
  assert.equal(await fs.readFile(marker, 'utf8'), 'YES');
  assert.equal(result.resourcesKnown, false); assert.equal(result.passed, false);
  assert.ok(result.resourceObservation.unknown.some(item => item.reason === 'CHILD_OBSERVER_NOT_INHERITED'));
  assert.ok(result.resourceObservation.observedChildren.some(child => child.sync && !child.nodeObserver && child.rawExit?.code === 0));
  t.diagnostic(JSON.stringify(result));
});

test('a synchronous Node controller cannot hide its detached HTTP descendant', {skip:process.platform==='win32'}, async t => {
  const fixture = await detachedScene(t), wrapper = path.join(fixture.root, 'sync-controller.test.mjs');
  await fs.writeFile(wrapper, `import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
test('actual synchronous controller',()=>{const env={...process.env};delete env.NODE_TEST_CONTEXT;const result=spawnSync(process.execPath,['--test',${JSON.stringify(fixture.file)}],{env,stdio:'ignore'});assert.equal(result.status,0);assert.equal(result.signal,null);});`);
  const result = await runTestFile(wrapper, {cwd:fixture.root, timeoutMs:3000, graceMs:500, output:()=>{}});
  assert.deepEqual(result.rawExit, {code:0, signal:null});
  assert.equal(result.resourcesKnown, false); assert.equal(result.passed, false);
  const state = await fixture.readState(), response = await fetch(`http://127.0.0.1:${state.port}`);
  assert.equal(response.status, 200); await response.text();
  assert.ok(result.resourceObservation.observedChildren.some(child => child.sync && child.nodeObserver && child.rawExit?.code === 0));
  assert.ok(result.resourceObservation.unknown.some(item => item.reason === 'EXIT_RECEIPT_MISSING' && item.pid === state.pid));
  t.diagnostic(JSON.stringify({result, aliveHttpAfterReturn:200, fixture:state}));
});

test('the actual TLS helper passes with LIMITED direct-native coverage after real openssl close zero', async t => {
  const root = await scene(t), file = path.join(root, 'tls-helper.test.mjs');
  await fs.writeFile(file, `import test from 'node:test';import assert from 'node:assert/strict';import {makeTlsFixture} from ${JSON.stringify(path.join(repo, 'tests/audio-engine-fixtures.mjs'))};
test('actual supplied TLS fixture',async t=>{const tls=await makeTlsFixture(t);assert.ok(tls.ca.includes('BEGIN CERTIFICATE'));});`);
  const result = await runTestFile(file, {cwd:root, timeoutMs:3000, graceMs:500, output:()=>{}});
  assert.deepEqual(result.rawExit, {code:0, signal:null});
  const openssl = result.resourceObservation.observedChildren.find(child => child.executable === 'openssl');
  assert.ok(openssl); assert.equal(openssl.sync, false); assert.equal(openssl.nodeObserver, false);
  assert.deepEqual(openssl.rawExit, {code:0, signal:null});
  assert.equal(result.resourcesKnown, false); assert.equal(result.observedResourcesClosed, true); assert.equal(result.passed, true);
  assert.equal(result.resourceObservation.state, 'LIMITED');
  assert.deepEqual(result.resourceObservation.unknown, []);
  assert.ok(result.resourceObservation.limitations.some(item => item.reason === 'EXTERNAL_DESCENDANTS_NOT_OBSERVED' && item.pid === openssl.pid));
  t.diagnostic(JSON.stringify({result, nativeToolActualClose:openssl.rawExit, coverageLimit:'Only observed direct tool closure; opaque external descendants are NOT_COVERED'}));
});

test('the public CLI reports LIMITED and continues after an actually closed ordinary external tool', {skip:process.platform==='win32'}, async t => {
  const root = await scene(t), mini = path.join(root, 'mini'), sentinel = path.join(mini, 'second-ran');
  await fs.mkdir(path.join(mini, 'scripts'), {recursive:true}); await fs.mkdir(path.join(mini, 'tests'));
  for (const name of ['test-suites.mjs', 'test-resource-ledger.cjs', 'test-resource-observer.cjs']) {
    await fs.copyFile(path.join(repo, 'scripts', name), path.join(mini, 'scripts', name));
  }
  await fs.writeFile(path.join(mini, 'tests/a-tool.test.mjs'), `import test from 'node:test';import {execFileSync} from 'node:child_process';test('real closed tool',()=>execFileSync('/usr/bin/true'));`);
  await fs.writeFile(path.join(mini, 'tests/b-later.test.mjs'), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(sentinel)},'OK');`);
  const env = {...process.env}; delete env.NODE_TEST_CONTEXT;
  const execution = await exec(process.execPath, ['scripts/test-suites.mjs', '--timeout', '3000'], {cwd:mini, env});
  const results = execution.stdout.split('\n').filter(line => line.startsWith('[test-file-result] ')).map(line => JSON.parse(line.slice('[test-file-result] '.length)));
  assert.equal(results.length, 2); assert.equal(results[0].resourceObservation.state, 'LIMITED');
  assert.equal(results[0].resourcesKnown, false); assert.equal(results[0].observedResourcesClosed, true); assert.equal(results[0].passed, true);
  assert.match(execution.stderr, /LIMITED/); assert.equal(await fs.readFile(sentinel, 'utf8'), 'OK');
  t.diagnostic(JSON.stringify({execution, results, sentinelRan:true}));
});
