import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {PassThrough, Writable} from 'node:stream';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {ProjectVideoDesktopNative} from '../server/project-videos/desktop-native.mjs';

// No real native process is launched by this suite. A runner fixture models
// process exit separately from stdout/ack, including uncooperative children.
async function fixture(t, {respond, hang, stat, stubborn = false, eligible = true} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'video-native-test-'));
  const developer = path.join(root, 'developer');
  await fs.mkdir(path.join(developer, 'usr/bin'), {recursive: true});
  await fs.mkdir(path.join(developer, 'SDKs/MacOSX.sdk'), {recursive: true});
  await fs.writeFile(path.join(developer, 'usr/bin/swiftc'), 'fixture compiler, never executed', {mode: 0o700});
  const calls = [];
  const runner = (program, args, options) => {
    const child = new EventEmitter();
    const call = {program, args, options, child, input: '', kills: []};
    calls.push(call);
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    let exited = false;
    const finish = (stdout, code = 0, signal = null) => {
      if (exited) return;
      exited = true;
      if (stdout !== undefined) child.stdout.write(typeof stdout === 'string' ? stdout : JSON.stringify({protocol: 1, ok: true, ...stdout}));
      child.stdout.end(); child.stderr.end(); child.emit('close', code, signal);
    };
    call.finish = finish;
    child.kill = signal => { call.kills.push(signal); if (!stubborn) queueMicrotask(() => finish('', null, signal)); return true; };
    child.stdin = new Writable({write(chunk, encoding, done) { call.input += chunk.toString(); done(); }, final(done) {
      done();
      queueMicrotask(async () => {
        try {
          if (program === '/usr/bin/stat') { const result = stat?.() || {stdout: String(process.geteuid?.() || 501)}; finish(result.stdout, result.code ?? 0, result.signal ?? null); return; }
          if (program === '/usr/bin/xcode-select') { finish(developer); return; }
          const compile = args.includes('-module-cache-path');
          call.request = compile ? {operation: 'compile'} : JSON.parse(call.input);
          if (hang?.(call)) return;
          if (respond) { const result = await respond(call); if (result !== undefined) { finish(result.stdout ?? result, result.code ?? 0, result.signal ?? null); return; } }
          if (compile) {
            await fs.writeFile(args[args.indexOf('-o') + 1], 'fixture binary; never execute', {mode: 0o700});
            finish(''); return;
          }
          switch (call.request.operation) {
          case 'capabilities': finish({clipboard: {available: true}, revealMany: {available: true}}); break;
          case 'clipboard-version': finish({changeCount: 41}); break;
          case 'copy-files': finish({ack: 'written', count: call.request.paths.length, changeCount: 42}); break;
          case 'reveal-files': finish({ack: 'dispatched', count: call.request.paths.length}); break;
          case 'open-folder': finish({ack: 'dispatched'}); break;
          default: throw Error('unexpected fixture request');
          }
        } catch (e) { finish('fixture failure', 1); }
      });
    }});
    return child;
  };
  const native = new ProjectVideoDesktopNative({directory: root, platform: 'darwin', runner});
  // The fake desktop must also work in Linux/root CI; real session checks have
  // dedicated tests below. Native session responses remain part of the protocol.
  if (eligible) native.eligible = async () => native.assertOpen();
  t.after(async () => {
    for (const call of calls) if (call.kills.length && stubborn) call.finish('', null, 'SIGKILL');
    try { await native.close(); } catch (e) { if (!stubborn || e.code !== 'NATIVE_EXIT_UNSETTLED') throw e; }
    for (const call of calls.filter(c => c.request?.operation === 'compile')) await fs.rm(call.options.env.TMPDIR, {recursive: true, force: true});
    await fs.rm(root, {recursive: true, force: true});
  });
  return {root, developer, native, calls, runner};
}
const operations = calls => calls.filter(c => c.request).map(c => c.request.operation);
const failure = code => e => e.code === code && !e.message.includes('PRIVATE') && !e.stderr && !e.cause;
async function launched(calls, operation) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const call = calls.find(c => c.request?.operation === operation);
    if (call) return call;
    await nextTurn();
  }
  throw Error(`fixture did not launch ${operation}`);
}

test('capability read without cached helper neither compiles nor changes desktop', async t => {
  const {native, calls, root} = await fixture(t);
  assert.deepEqual(operations(calls), []);
  const caps = await native.capabilities();
  assert.equal(caps.clipboard.available, false);
  assert.equal(caps.clipboard.code, 'NATIVE_HELPER_UNAVAILABLE');
  assert.equal(caps.revealMany.available, false);
  assert.equal(calls.length, 0);
  assert.deepEqual((await fs.readdir(root)).sort(), ['developer']);
});

test('unsupported platform and container reject without launching a runner', async t => {
  let calls = 0;
  for (const platform of ['linux', 'win32']) {
    const native = new ProjectVideoDesktopNative({platform, runner() { calls++; throw Error('unexpected'); }});
    assert.equal((await native.capabilities()).clipboard.code, 'DESKTOP_PLATFORM_UNAVAILABLE');
    await assert.rejects(native.clipboardVersion(), failure('DESKTOP_PLATFORM_UNAVAILABLE'));
    await native.close();
  }
  t.mock.method(process, 'geteuid', () => 501); t.mock.method(process, 'getuid', () => 501);
  const before = process.env.MEDIA_CONTAINER; process.env.MEDIA_CONTAINER = '1';
  try {
    const native = new ProjectVideoDesktopNative({platform: 'darwin', runner() { calls++; }});
    assert.equal((await native.capabilities()).revealMany.code, 'DESKTOP_PLATFORM_UNAVAILABLE');
    await native.close();
  } finally { if (before === undefined) delete process.env.MEDIA_CONTAINER; else process.env.MEDIA_CONTAINER = before; }
  assert.equal(calls, 0);
});

test('session requires equal non-root real/effective/console UID, stat exit checked', async t => {
  let consoleUID = 501, statCode = 0;
  const {native, calls} = await fixture(t, {eligible: false, stat: () => ({stdout: String(consoleUID), code: statCode})});
  t.mock.method(process, 'geteuid', () => 501);
  const real = t.mock.method(process, 'getuid', () => 502);
  assert.equal((await native.capabilities()).clipboard.code, 'DESKTOP_SESSION_UNAVAILABLE');
  assert.equal(calls.length, 0);
  real.mock.mockImplementation(() => 501);
  assert.equal((await native.capabilities()).clipboard.code, 'NATIVE_HELPER_UNAVAILABLE');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['-f', '%u', '/dev/console']);
  consoleUID = 502;
  assert.equal((await native.capabilities()).clipboard.code, 'DESKTOP_SESSION_UNAVAILABLE');
  consoleUID = 501; statCode = 1;
  assert.equal((await native.capabilities()).clipboard.code, 'DESKTOP_SESSION_UNAVAILABLE');
  t.mock.method(process, 'geteuid', () => 0);
  assert.equal((await native.capabilities()).clipboard.code, 'DESKTOP_SESSION_UNAVAILABLE');
});

test('first action prepares a hash-checked private helper; concurrent preparation coalesces', async t => {
  const {native, calls, root} = await fixture(t);
  assert.deepEqual(await Promise.all([native.clipboardVersion(), native.clipboardVersion()]), [41, 41]);
  assert.equal(operations(calls).filter(x => x === 'compile').length, 1);
  const compile = calls.find(c => c.request?.operation === 'compile');
  assert.ok(compile.program.endsWith('/developer/usr/bin/swiftc'));
  assert.ok(compile.args.includes('AppKit'));
  assert.ok(compile.options.cwd.startsWith(path.join(root, 'video-desktop-native/.build-')));
  assert.ok(compile.options.env.TMPDIR.startsWith(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'sg-vn-')));
  assert.ok(compile.args.includes(path.join(root, 'developer/SDKs/MacOSX.sdk')));
  await assert.rejects(fs.stat(compile.options.env.TMPDIR), e => e.code === 'ENOENT');
  assert.equal(compile.options.shell, false);
  const cache = path.join(root, 'video-desktop-native');
  assert.equal((await fs.readdir(cache)).length, 2);
  const manifest = JSON.parse(await fs.readFile(path.join(cache, (await fs.readdir(cache)).find(x => x.endsWith('.json'))), 'utf8'));
  assert.match(manifest.sourceHash, /^[a-f0-9]{64}$/); assert.match(manifest.binaryHash, /^[a-f0-9]{64}$/);
  const before = calls.length;
  assert.deepEqual(await native.capabilities(), {clipboard: {available: true}, revealMany: {available: true}});
  assert.deepEqual(operations(calls.slice(before)), ['capabilities']);
  assert.ok(calls.every(c => c.options.shell === false));
});

test('JSON stdin preserves Chinese, quotes, newlines and shell metacharacters as paths', async t => {
  const {native, calls} = await fixture(t);
  const files = ["/fixture/中文 空格 ' \" $(touch PWNED) `cmd` &.mov", '/fixture/换\n行.mp4'];
  assert.deepEqual(await native.copyFiles(files, {expectedChangeCount: 41}), {ack: 'written', count: 2, changeCount: 42});
  assert.deepEqual(await native.revealFiles(files), {ack: 'dispatched', count: 2});
  for (const call of calls.filter(c => ['copy-files', 'reveal-files'].includes(c.request?.operation))) {
    assert.deepEqual(call.args, []); assert.deepEqual(call.request.paths, files);
    assert.equal(call.options.shell, false); assert.equal(call.request.protocol, 1);
  }
});

test('empty/invalid files and missing version never compile or write', async t => {
  const {native, calls} = await fixture(t);
  for (const files of [[], ['relative.mov'], ['/tmp/null\0.mov'], [42], Array(1001).fill('/fixture/a')]) {
    await assert.rejects(native.copyFiles(files, {expectedChangeCount: 41}), e => ['EMPTY_FILES', 'INVALID_FILES'].includes(e.code));
  }
  for (const count of [undefined, -1, 1.5, '41', true, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(native.copyFiles(['/fixture/a'], {expectedChangeCount: count}), failure('INVALID_CHANGE_COUNT'));
  await assert.rejects(native.revealFiles([]), failure('EMPTY_FILES'));
  assert.equal(calls.length, 0);
});

test('CLIPBOARD_CHANGED is a safe refusal and never becomes a native success', async t => {
  const {native} = await fixture(t, {respond(call) {
    if (call.request.operation === 'copy-files') return {stdout: JSON.stringify({protocol: 1, ok: false, code: 'CLIPBOARD_CHANGED', reason: 'PRIVATE user contents'}), code: 2};
  }});
  await assert.rejects(native.copyFiles(['/fixture/a'], {expectedChangeCount: 40}), e => failure('CLIPBOARD_CHANGED')(e) && e.effectUnknown === false && e.status === 409);
});

test('helper session rejection remains unavailable even with a valid cached binary', async t => {
  const {native} = await fixture(t, {respond(call) {
    if (call.request.operation === 'capabilities') return {stdout: JSON.stringify({protocol: 1, ok: false, code: 'DESKTOP_SESSION_UNAVAILABLE'}), code: 2};
  }});
  await native.clipboardVersion();
  assert.equal((await native.capabilities()).clipboard.code, 'DESKTOP_SESSION_UNAVAILABLE');
});

test('bad JSON, wrong acknowledgements and success with nonzero exit cannot pass', async t => {
  for (const result of [
    {stdout: 'PRIVATE bad JSON'},
    {stdout: JSON.stringify({protocol: 1, ok: true, ack: 'written', count: 1, changeCount: 42}), code: 3},
    {stdout: JSON.stringify({protocol: 1, ok: true, ack: 'dispatched', count: 1, changeCount: 42})},
    {stdout: JSON.stringify({protocol: 1, ok: true, ack: 'written', count: 2, changeCount: 42})},
    {stdout: JSON.stringify({protocol: 2, ok: true, ack: 'written', count: 1, changeCount: 42})},
    {stdout: JSON.stringify({protocol: 1, ok: true, ack: 'written', count: 1, changeCount: -1})},
    {stdout: JSON.stringify({protocol: 1, ok: true, ack: 'written', count: 1, changeCount: 42}), signal: 'SIGTERM'},
    {stdout: 'x'.repeat(65537)},
  ]) {
    const {native} = await fixture(t, {respond: call => call.request.operation === 'copy-files' ? result : undefined});
    await assert.rejects(native.copyFiles(['/fixture/a'], {expectedChangeCount: 41}), e => ['NATIVE_PROTOCOL_ERROR', 'NATIVE_FAILED'].includes(e.code) && e.effectUnknown === true);
  }
});

test('cached helper is reused across instances; tampering or stale source manifest forces preparation', async t => {
  const {native, root, calls, runner} = await fixture(t);
  await native.clipboardVersion();
  await native.close();
  const another = new ProjectVideoDesktopNative({directory: root, runner, platform: 'darwin'});
  another.eligible = async () => another.assertOpen(); t.after(() => another.close());
  const before = calls.length;
  assert.equal(await another.clipboardVersion(), 41);
  assert.deepEqual(operations(calls.slice(before)), ['clipboard-version']);
  const cache = path.join(root, 'video-desktop-native');
  const binary = path.join(cache, (await fs.readdir(cache)).find(n => !n.endsWith('.json')));
  await fs.writeFile(binary, 'corrupted fixture');
  assert.equal((await another.capabilities()).clipboard.code, 'NATIVE_HELPER_UNAVAILABLE');
  assert.equal(await another.clipboardVersion(), 41);
  const manifestPath = path.join(cache, (await fs.readdir(cache)).find(n => n.endsWith('.json')));
  const manifest = JSON.parse(await fs.readFile(manifestPath)); manifest.sourceHash = 'old source';
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  assert.equal((await another.capabilities()).revealMany.code, 'NATIVE_HELPER_UNAVAILABLE');
  assert.equal(await another.clipboardVersion(), 41);
  assert.equal(operations(calls).filter(op => op === 'compile').length, 3);
});

test('cache symlink is refused, compiler absence is explicit and no installation is attempted', async t => {
  const {native, root, calls, developer} = await fixture(t);
  await fs.symlink(developer, path.join(root, 'video-desktop-native'));
  await assert.rejects(native.clipboardVersion(), failure('NATIVE_HELPER_UNAVAILABLE'));
  assert.equal(operations(calls).length, 0);
  await fs.unlink(path.join(root, 'video-desktop-native'));
  await fs.unlink(path.join(developer, 'usr/bin/swiftc'));
  await assert.rejects(native.clipboardVersion(), failure('NATIVE_COMPILER_UNAVAILABLE'));
  assert.ok(calls.every(c => c.program === '/usr/bin/xcode-select'));
});

test('close kills and waits for compilation and prevents subsequent native actions', async t => {
  const {native, calls, root} = await fixture(t, {hang: call => call.request.operation === 'compile'});
  const work = native.clipboardVersion(); const failed = assert.rejects(work, failure('APPLICATION_CLOSING'));
  const compile = await launched(calls, 'compile');
  const closing = native.close(); assert.equal(native.close(), closing);
  await closing; await failed;
  assert.deepEqual(compile.kills, ['SIGTERM']);
  assert.equal(native.children.size, 0); assert.equal(native.pending.size, 0);
  assert.deepEqual(await fs.readdir(path.join(root, 'video-desktop-native')), []);
  const count = calls.length;
  await assert.rejects(native.copyFiles(['/fixture/a'], {expectedChangeCount: 41}), failure('APPLICATION_CLOSING'));
  assert.equal((await native.capabilities()).clipboard.code, 'APPLICATION_CLOSING');
  assert.equal(calls.length, count);
});

test('action timeout terminates the child and reports an unknown effect', async t => {
  const {native, calls} = await fixture(t, {hang: call => call.request.operation === 'copy-files'});
  await native.clipboardVersion();
  t.mock.timers.enable({apis: ['setTimeout']});
  const work = native.copyFiles(['/fixture/a'], {expectedChangeCount: 41});
  const failed = assert.rejects(work, e => e.code === 'NATIVE_TIMEOUT' && e.effectUnknown === true);
  const call = await launched(calls, 'copy-files');
  t.mock.timers.tick(5001); await failed;
  assert.deepEqual(call.kills, ['SIGTERM']); assert.equal(native.children.size, 0);
  t.mock.timers.reset();
});

test('compiler timeout is bounded, tracked and removes its private scratch after known exit', async t => {
  const {native, calls, root} = await fixture(t, {hang: call => call.request.operation === 'compile'});
  t.mock.timers.enable({apis: ['setTimeout']});
  const work = native.clipboardVersion(); const failed = assert.rejects(work, e => e.code === 'NATIVE_TIMEOUT' && e.effectUnknown === false);
  const call = await launched(calls, 'compile');
  t.mock.timers.tick(45001); await failed;
  assert.deepEqual(call.kills, ['SIGTERM']); assert.equal(native.children.size, 0);
  assert.deepEqual(await fs.readdir(path.join(root, 'video-desktop-native')), []);
  await assert.rejects(fs.stat(call.options.env.TMPDIR), e => e.code === 'ENOENT');
  t.mock.timers.reset();
});

test('compiler failure and runner spawn errors are sanitized, without caching success', async t => {
  const {native, root, calls} = await fixture(t, {respond: call => call.request.operation === 'compile' ? {stdout: 'PRIVATE diagnostics', code: 1} : undefined});
  await assert.rejects(native.clipboardVersion(), failure('NATIVE_COMPILER_UNAVAILABLE'));
  assert.deepEqual(await fs.readdir(path.join(root, 'video-desktop-native')), []);
  assert.equal(native.children.size, 0);
  native.runner = () => { throw Error('PRIVATE spawn error'); };
  await assert.rejects(native.clipboardVersion(), failure('NATIVE_FAILED'));
  assert.equal(operations(calls).filter(x => x === 'clipboard-version').length, 0);
});

test('clipboard version, reveal ack and capability DTO are validated independently', async t => {
  let operationResult;
  const {native} = await fixture(t, {respond: call => call.request.operation !== 'compile' ? operationResult : undefined});
  await native.clipboardVersion();
  for (const changeCount of [-1, 1.5, true, '41', Number.MAX_SAFE_INTEGER + 1]) {
    operationResult = {changeCount}; await assert.rejects(native.clipboardVersion(), failure('NATIVE_PROTOCOL_ERROR'));
  }
  operationResult = {ack: 'written', count: 1};
  await assert.rejects(native.revealFiles(['/fixture/a']), e => e.code === 'NATIVE_PROTOCOL_ERROR' && e.effectUnknown === true);
  operationResult = {clipboard: {available: 'yes'}, revealMany: {available: true}};
  assert.equal((await native.capabilities()).clipboard.code, 'NATIVE_PROTOCOL_ERROR');
  operationResult = {clipboard: {available: false, code: 'DESKTOP_SESSION_UNAVAILABLE', reason: 'PRIVATE'}, revealMany: {available: true}};
  const caps = await native.capabilities(); assert.equal(caps.clipboard.code, 'DESKTOP_SESSION_UNAVAILABLE');
  assert.equal(caps.revealMany.available, true); assert.ok(!JSON.stringify(caps).includes('PRIVATE'));
});

test('close during a dispatched action reports uncertainty and waits for real close', async t => {
  const {native, calls} = await fixture(t, {hang: call => call.request.operation === 'copy-files'});
  await native.clipboardVersion();
  const work = native.copyFiles(['/fixture/a'], {expectedChangeCount: 41});
  const failed = assert.rejects(work, e => e.code === 'APPLICATION_CLOSING' && e.effectUnknown === true);
  const call = await launched(calls, 'copy-files');
  await native.close(); await failed;
  assert.deepEqual(call.kills, ['SIGTERM']); assert.equal(native.children.size, 0);
});

test('SIGTERM escalates to SIGKILL; unconfirmed exit makes close fail visibly', async t => {
  const {native, calls} = await fixture(t, {hang: call => call.request.operation === 'reveal-files', stubborn: true});
  await native.clipboardVersion();
  t.mock.timers.enable({apis: ['setTimeout']});
  const work = native.revealFiles(['/fixture/a']); const failed = assert.rejects(work, failure('NATIVE_EXIT_UNSETTLED'));
  const call = await launched(calls, 'reveal-files');
  const closing = native.close(); const closeFailed = assert.rejects(closing, failure('NATIVE_EXIT_UNSETTLED'));
  t.mock.timers.tick(201); assert.deepEqual(call.kills, ['SIGTERM', 'SIGKILL']);
  t.mock.timers.tick(1000); await failed; await closeFailed;
  assert.equal(native.children.size, 1);
  call.finish('', null, 'SIGKILL'); assert.equal(native.children.size, 0);
  t.mock.timers.reset();
  // close preserves its truthful original unsettled result.
  await assert.rejects(native.close(), failure('NATIVE_EXIT_UNSETTLED'));
});

test('image and video clipboard mutations through the shared helper cannot overlap check/write', async t=>{
  const native=new ProjectVideoDesktopNative({directory:'/tmp/unused-fixture'});
  t.after(()=>native.close());
  native.helper=async()=>'/tmp/owned-stub';
  let version=11, writes=[], called=[], admit, entered;
  const hold=new Promise(r=>{admit=r;}), firstRead=new Promise(r=>{entered=r;});
  native.invoke=async(_binary,args)=>{
    if(args.operation==='clipboard-version')return {changeCount:version};
    called.push(args.paths[0]);
    if(args.expectedChangeCount!==version)throw Object.assign(Error('changed'),{code:'CLIPBOARD_CHANGED',effectUnknown:false});
    if(args.paths[0].endsWith('.png')){entered();await hold;}
    writes.push(args.paths[0]);version++;
    return {ack:'written',count:1,changeCount:version};
  };
  const expected=await native.clipboardVersion();
  const a=native.copyFiles(['/tmp/owned.png'],{expectedChangeCount:expected});
  await firstRead;
  const b=native.copyFiles(['/tmp/owned.mp4'],{expectedChangeCount:await native.clipboardVersion()});
  const failed=assert.rejects(b,{code:'CLIPBOARD_CHANGED'});
  await new Promise(r=>setImmediate(r));
  assert.deepEqual(called,['/tmp/owned.png']);
  admit();await a;await failed;
  assert.deepEqual(writes,['/tmp/owned.png']);
});

test('openFolder sends the fixed folder identity only after validation and classifies pre-dispatch refusals', async t => {
  const {native, calls} = await fixture(t);
  const identity={dev:'1',ino:'2'};
  await assert.rejects(native.openFolder('/tmp/owned',{identity,beforeDispatch(){
    throw Object.assign(new Error('changed'),{code:'TARGET_CHANGED'});
  }}),{code:'TARGET_CHANGED',effectUnknown:false});
  assert.ok(!operations(calls).includes('open-folder'));
  assert.deepEqual(await native.openFolder('/tmp/owned',{identity}),{ack:'dispatched'});
  assert.deepEqual(calls.find(c=>c.request?.operation==='open-folder').request,{
    protocol:1,operation:'open-folder',target:'/tmp/owned',identity,
  });
});
