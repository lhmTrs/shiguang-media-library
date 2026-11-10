import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {constants} from 'node:fs';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {ProjectVideoDesktopNative} from '../server/project-videos/desktop-native.mjs';

const posix = {skip: process.platform === 'win32', timeout: 15000};
const outcome = work => work.then(value => ({value}), error => ({error: error.code, effectUnknown: error.effectUnknown}));
function groupAbsent(pgid) {
  try { process.kill(-pgid, 0); return false; }
  catch (e) { if (e.code === 'ESRCH') return true; throw e; }
}
function state(pid) {
  const r = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,pgid=,stat='], {encoding: 'utf8', timeout: 2000});
  assert.ifError(r.error);
  assert.ok(r.status === 0 || r.status === 1, 'own PID status is readable');
  const fields = r.stdout.trim().split(/\s+/);
  return fields[0] ? {pid: Number(fields[0]), pgid: Number(fields[1]), stat: fields[2]} : null;
}
const notRunning = s => !s || s.stat.startsWith('Z');
async function waitFor(check, message) {
  for (let i = 0; i < 200; i++) {
    const value = await check();
    if (value) return value;
    await delay(10);
  }
  assert.fail(message);
}

async function invocation(t, {normalExit = false, timeout = 800, mutation = false} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sg-native-owned-group-'));
  const pidFile = path.join(dir, 'descendant.pid'), parentFile = path.join(dir, 'parent.cjs');
  // Install TERM resistance before publishing readiness. stdio ignore lets the
  // parent emit close while this child is still executing in the same group.
  const descendantCode = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000);`;
  await fs.writeFile(parentFile, `
    const fs = require('node:fs');
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], {stdio:'ignore'});
    const ready = () => {
      if (!fs.existsSync(${JSON.stringify(pidFile)})) return setTimeout(ready, 5);
      if (${normalExit}) { process.stdout.write('parent-ok'); process.exit(0); }
      else setInterval(()=>{},1000);
    };
    ready();
  `);
  const native = new ProjectVideoDesktopNative({directory: dir});
  const work = outcome(native.run(process.execPath, [parentFile], '', timeout, {mutation}));
  const child = [...native.children.keys()][0], pgid = child.pid;
  assert.ok(Number.isSafeInteger(pgid) && pgid > 0);
  let descendant;
  t.after(async () => {
    try {
      // This fallback also runs against the broken implementation. Signal only
      // the group just created by this fixture, never a discovered user PID.
      if (!groupAbsent(pgid)) process.kill(-pgid, 'SIGKILL');
      await work;
      await native.close().catch(e => assert.equal(e.code, 'NATIVE_EXIT_UNSETTLED'));
      await waitFor(() => notRunning(state(pgid)) && (!descendant || notRunning(state(descendant))),
        'fixture must leave neither parent nor descendant executing');
      t.diagnostic(JSON.stringify({cleanup: {pgid, descendant, parent: state(pgid), child: descendant && state(descendant),
        groupAbsent: groupAbsent(pgid), ownProcessesKnownNotRunning: true}}));
    } finally { await fs.rm(dir, {recursive: true, force: true}); }
  });
  descendant = await waitFor(async () => {
    try { return Number(await fs.readFile(pidFile, 'utf8')); } catch { return false; }
  }, 'TERM-resistant descendant becomes ready');
  const readyState = state(descendant);
  assert.equal(readyState?.pgid, pgid, 'descendant belongs to this spawn, without detaching');
  assert.equal(notRunning(readyState), false);
  return {native, work, pgid, descendant, child, mutation};
}

async function assertSettled(t, f, run, closing, expectedError) {
  await waitFor(() => notRunning(state(f.descendant)), 'TERM-resistant descendant must be terminated');
  if (run.error === 'NATIVE_EXIT_UNSETTLED') {
    assert.equal(run.effectUnknown, f.mutation);
  } else {
    assert.equal(run.error, expectedError);
    assert.equal(groupAbsent(f.pgid), true, 'a known result requires the entire group to be absent');
  }
  if (closing.error) assert.equal(closing.error, 'NATIVE_EXIT_UNSETTLED');
  else {
    assert.equal(groupAbsent(f.pgid), true, 'close success requires group absence, including no zombie ambiguity');
    assert.equal(f.native.children.size, 0);
  }
  t.diagnostic(JSON.stringify({pgid: f.pgid, descendant: f.descendant, run, close: closing,
    tracked: f.native.children.size, groupAbsent: groupAbsent(f.pgid), descendantState: state(f.descendant)}));
}

test('real timeout retains group cleanup after the parent closes', posix, async t => {
  const f = await invocation(t);
  const run = await f.work;
  const closing = await outcome(f.native.close());
  await assertSettled(t, f, run, closing, 'NATIVE_TIMEOUT');
});

test('close while a direct real run is active waits for the TERM-resistant group', posix, async t => {
  const f = await invocation(t, {timeout: 10000, mutation: true});
  const closing = f.native.close();
  assert.equal(f.native.close(), closing, 'close keeps its promise identity');
  let closed = false; closing.then(() => { closed = true; }, () => { closed = true; });
  await delay(50);
  assert.equal(notRunning(state(f.descendant)), false, 'the resistant descendant survives TERM');
  assert.equal(closed, false, 'parent close alone cannot complete native.close');
  const run = await f.work;
  await assertSettled(t, f, run, await outcome(closing), 'APPLICATION_CLOSING');
});

test('normal parent completion also settles its leftover owned descendants', posix, async t => {
  const f = await invocation(t, {normalExit: true, timeout: 10000});
  const run = await f.work;
  if (!run.error) assert.deepEqual(run.value, {stdout: 'parent-ok', code: 0, signal: null});
  await assertSettled(t, f, run, await outcome(f.native.close()), undefined);
});

test('real spawn keeps its owned group if the configured runner changes during execution', posix, async t => {
  const f = await invocation(t, {timeout: 10000});
  f.native.runner = () => { throw Error('replacement runner must not run'); };
  const closing = outcome(f.native.close());
  const run = await f.work;
  await assertSettled(t, f, run, await closing, 'APPLICATION_CLOSING');
});

test('persistent group presence cannot become known exit after parent close and KILL', posix, async t => {
  const f = await invocation(t, {timeout: 10000, mutation: true});
  const realKill = process.kill.bind(process), signals = [];
  const probe = t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, -f.pgid, 'only this real spawn group may be probed or signaled');
    signals.push(signal);
    // Model macOS reporting a zombie group after the real owned processes have
    // stopped. Deliver the actual TERM/KILL; never fake their termination.
    if (signal === 0) return true;
    return realKill(pid, signal);
  });
  let run, closing;
  try {
    const closeWork = outcome(f.native.close());
    run = await f.work; closing = await closeWork;
    assert.equal(run.error, 'NATIVE_EXIT_UNSETTLED'); assert.equal(run.effectUnknown, true);
    assert.equal(closing.error, 'NATIVE_EXIT_UNSETTLED');
    assert.equal(f.native.children.size, 1, 'unknown ownership responsibility remains tracked');
    assert.deepEqual(signals.filter(s => s !== 0), ['SIGTERM', 'SIGKILL']);
    assert.ok(signals.includes(0));
  } finally { probe.mock.restore(); }
  await waitFor(() => notRunning(state(f.descendant)), 'ambiguous exit still terminates the actual descendant');
  t.diagnostic(JSON.stringify({ambiguousProbe: {pgid: f.pgid, descendant: f.descendant, run, close: closing,
    tracked: f.native.children.size, actualGroupAbsent: groupAbsent(f.pgid), descendantState: state(f.descendant)}}));
});

test('a supplied runner PID never grants group ownership, even after runner replacement', {timeout: 5000}, async t => {
  const fake = new EventEmitter(), signals = [];
  fake.pid = process.pid;
  fake.stdin = new PassThrough(); fake.stdout = new PassThrough(); fake.stderr = new PassThrough();
  fake.kill = signal => { signals.push(signal); queueMicrotask(() => fake.emit('close', null, signal)); return true; };
  let groupSignals = 0;
  const guard = t.mock.method(process, 'kill', () => { groupSignals++; throw Error('not an owned real-spawn group'); });
  const native = new ProjectVideoDesktopNative({runner: () => fake});
  try {
    const work = outcome(native.run('fixture', [], '', 10000));
    native.runner = spawn;
    await native.close();
    assert.equal((await work).error, 'APPLICATION_CLOSING');
    assert.deepEqual(signals, ['SIGTERM']); assert.equal(groupSignals, 0);
    assert.equal(native.children.size, 0);
  } finally {
    guard.mock.restore();
    fake.emit('close', null, 'SIGKILL');
    await native.close().catch(() => {});
  }
});

test('normal real Swift compilation returns only after its process group is absent', {skip: process.platform !== 'darwin', timeout: 60000}, async t => {
  // Read the selected installation; never execute the installation shim.
  const selected = spawnSync('/usr/bin/xcode-select', ['-p'], {encoding: 'utf8', timeout: 2000});
  const developer = selected.stdout?.trim();
  if (selected.status !== 0 || !path.isAbsolute(developer || '')) return t.skip('no selected existing developer tools');
  let compiler;
  for (const p of [path.join(developer, 'usr/bin/swiftc'),
    path.join(developer, 'Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc')]) {
    try { await fs.access(p, constants.X_OK); if ((await fs.stat(p)).isFile()) { compiler = p; break; } } catch {}
  }
  if (!compiler) return t.skip('no existing Swift compiler');
  let sdk;
  for (const p of [path.join(developer, 'SDKs/MacOSX.sdk'),
    path.join(developer, 'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk')]) {
    try { if ((await fs.stat(p)).isDirectory()) { sdk = p; break; } } catch {}
  }
  if (!sdk) return t.skip('no existing macOS SDK');
  const dir = await fs.mkdtemp('/tmp/sg-native-swift-');
  const native = new ProjectVideoDesktopNative({directory: dir});
  let pgid;
  try {
    const source = path.join(dir, 'main.swift'), binary = path.join(dir, 'fixture');
    await fs.writeFile(source, 'print(40 + 2)\n');
    const work = outcome(native.run(compiler, ['-sdk', sdk, '-module-cache-path', path.join(dir, 'modules'), source, '-o', binary], '', 45000,
      {cwd: dir, env: {...process.env, TMPDIR: dir + path.sep}}));
    pgid = [...native.children.keys()][0].pid;
    const run = await work, closing = await outcome(native.close());
    assert.equal(run.error, undefined, 'ordinary Swift compilation has a known group exit');
    assert.equal(run.value.code, 0); assert.equal(run.value.signal, null);
    assert.equal(closing.error, undefined);
    assert.equal(native.children.size, 0);
    assert.equal(groupAbsent(pgid), true);
    assert.ok((await fs.stat(binary)).size > 0);
    t.diagnostic(JSON.stringify({swift: {pgid, run, close: closing, tracked: native.children.size, groupAbsent: true}}));
  } finally {
    if (pgid && !groupAbsent(pgid)) process.kill(-pgid, 'SIGKILL');
    await native.close().catch(e => assert.equal(e.code, 'NATIVE_EXIT_UNSETTLED'));
    await fs.rm(dir, {recursive: true, force: true});
  }
});
