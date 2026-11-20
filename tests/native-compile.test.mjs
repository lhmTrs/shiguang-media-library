// 本机编译进程组：超时、取消、服务被关闭时，编译器和它启动的子进程都要结束。
// 只用合成的 shell 脚本冒充编译器，不调用真实 swiftc。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runInProcessGroup, activeCompileCount} from '../server/native-compile.mjs';

const helper = fileURLToPath(new URL('../server/native-compile.mjs', import.meta.url));
const unix = process.platform !== 'win32';
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await new Promise(r => setTimeout(r, 25)); }
  return false;
};

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sg-native-compile-'));
  const pids = [];
  t.after(async () => {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await fs.rm(dir, {recursive: true, force: true});
  });
  // 冒充 swiftc：先启动一个「前端」子进程并记下它的进程号，然后等它。
  const compiler = path.join(dir, 'fake-swiftc');
  await fs.writeFile(compiler, '#!/bin/sh\nsleep 30 &\necho $! > "$1"\nwait\n', {mode: 0o700});
  const pidFile = path.join(dir, 'frontend.pid');
  const frontend = async () => {
    assert.ok(await until(async () => (await fs.readFile(pidFile, 'utf8').catch(() => '')).trim() !== ''), '假前端没有启动');
    const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
    pids.push(pid);
    return pid;
  };
  return {dir, compiler, pidFile, frontend};
}

test('成功时返回输出，并且不留下信号监听', {skip: !unix}, async t => {
  const {dir} = await fixture(t);
  const ok = path.join(dir, 'ok');
  await fs.writeFile(ok, '#!/bin/sh\necho compiled\n', {mode: 0o700});
  const before = process.listenerCount('SIGTERM');
  assert.deepEqual(await runInProcessGroup(ok, [], {timeout: 5000}), {stdout: 'compiled\n', stderr: ''});
  assert.equal(activeCompileCount(), 0);
  assert.equal(process.listenerCount('SIGTERM'), before);
});

test('编译失败时带退出码，killed 为 false', {skip: !unix}, async t => {
  const {dir} = await fixture(t);
  const bad = path.join(dir, 'bad');
  await fs.writeFile(bad, '#!/bin/sh\necho broken >&2\nexit 3\n', {mode: 0o700});
  await assert.rejects(runInProcessGroup(bad, []), e => e.code === 3 && e.killed === false && e.stderr === 'broken\n');
});

test('超时时结束整组，前端子进程也结束；错误和 execFile 一样标成 SIGTERM', {skip: !unix}, async t => {
  const {compiler, pidFile, frontend} = await fixture(t);
  const started = Date.now();
  const job = runInProcessGroup(compiler, [pidFile], {timeout: 400});
  const outcome = assert.rejects(job, e => e.killed === true && e.signal === 'SIGTERM');
  const pid = await frontend();
  await outcome;
  // 只结束 swiftc 本身时，前端还占着输出管道，要等它自己跑完（这里是 30 秒）才会返回。
  assert.ok(Date.now() - started < 5000, '超时后没有及时返回，前端子进程没被一起结束');
  assert.ok(await until(() => !alive(pid)), '超时后前端子进程还活着');
  assert.equal(activeCompileCount(), 0);
});

test('取消时结束整组', {skip: !unix}, async t => {
  const {compiler, pidFile, frontend} = await fixture(t);
  const abort = new AbortController();
  const job = runInProcessGroup(compiler, [pidFile], {signal: abort.signal});
  const outcome = assert.rejects(job, e => e.name === 'AbortError' && e.killed === true);
  const pid = await frontend();
  const started = Date.now();
  abort.abort();
  await outcome;
  assert.ok(Date.now() - started < 5000, '取消后没有及时返回，前端子进程没被一起结束');
  assert.ok(await until(() => !alive(pid)), '取消后前端子进程还活着');
});

async function parent(t, {appHandler}) {
  const {dir, compiler, pidFile, frontend} = await fixture(t);
  const script = path.join(dir, 'server.mjs');
  await fs.writeFile(script, [
    `import {runInProcessGroup} from ${JSON.stringify(helper)};`,
    appHandler ? `process.on('SIGTERM', () => { console.log('app-handler'); setTimeout(() => process.exit(0), 300); });` : '',
    `runInProcessGroup(${JSON.stringify(compiler)}, [${JSON.stringify(pidFile)}], {timeout: 60000})`,
    `  .then(() => console.log('compiled'), e => console.log('compile-stopped'));`,
    `setInterval(() => {}, 1000);`,
  ].join('\n'));
  const child = spawn(process.execPath, [script], {stdio: ['ignore', 'pipe', 'inherit']});
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  let stdout = '';
  child.stdout.on('data', d => { stdout += d; });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({code, signal})));
  const pid = await frontend();
  child.kill('SIGTERM');
  const result = await exited;
  return {pid, result, stdout: () => stdout};
}

test('服务启动早期收到 SIGTERM：结束编译组，再按默认行为退出', {skip: !unix}, async t => {
  const {pid, result} = await parent(t, {appHandler: false});
  assert.equal(result.signal, 'SIGTERM');
  assert.ok(await until(() => !alive(pid)), '服务退出后编译前端成了孤儿');
});

test('应用已有自己的关闭处理：只结束编译组，退出交给应用', {skip: !unix}, async t => {
  const {pid, result, stdout} = await parent(t, {appHandler: true});
  assert.equal(result.code, 0);
  assert.match(stdout(), /app-handler/);
  assert.match(stdout(), /compile-stopped/);
  assert.ok(await until(() => !alive(pid)), '应用关闭后编译前端成了孤儿');
});
