// 本机编译：超时、取消、服务被关闭时，编译器和它启动的「前端」子进程都要结束。
// 假编译器模仿真 swift-driver：前端放在它自己新建的进程组里（set -m），只有收到 SIGINT 时 driver
// 才会去结束前端。最后一项用真 swiftc（只在 macOS 且装了命令行工具时跑）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runNativeCompiler, activeCompileCount} from '../server/native-compile.mjs';

const helper = fileURLToPath(new URL('../server/native-compile.mjs', import.meta.url));
const unix = process.platform !== 'win32';
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };
const until = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await new Promise(r => setTimeout(r, 25)); }
  return false;
};
const pgid = pid => Number(spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], {encoding: 'utf8'}).stdout.trim());

// driver 收到 SIGINT 时的反应：cooperative 结束前端再退出（真 swift-driver 的行为）；
// leave 自己退出但不管前端；ignore 不理 SIGINT。detach 时前端不占输出管道。
const scripts = {
  cooperative: 'trap \'kill $fe 2>/dev/null; exit 130\' INT',
  leave: 'trap \'exit 130\' INT',
  ignore: 'trap \'\' INT',
};
async function fixture(t, mode = 'cooperative', {detach = false} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sg-native-compile-'));
  const pids = [];
  t.after(async () => {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await fs.rm(dir, {recursive: true, force: true});
  });
  const compiler = path.join(dir, 'fake-swiftc');
  await fs.writeFile(compiler, [
    '#!/bin/sh', 'set -m',
    detach ? 'sleep 30 >/dev/null 2>&1 &' : 'sleep 30 &',
    'fe=$!', 'echo $fe > "$1"', scripts[mode],
    'while kill -0 $fe 2>/dev/null; do wait $fe; done', '',
  ].join('\n'), {mode: 0o700});
  const pidFile = path.join(dir, 'frontend.pid');
  const frontend = async () => {
    assert.ok(await until(async () => (await fs.readFile(pidFile, 'utf8').catch(() => '')).trim() !== ''), '假前端没有启动');
    const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
    pids.push(pid);
    return pid;
  };
  return {dir, compiler, pidFile, frontend};
}

test('假编译器像真 driver：前端在自己的进程组里', {skip: !unix}, async t => {
  const {compiler, pidFile, frontend} = await fixture(t);
  const abort = new AbortController();
  const job = runNativeCompiler(compiler, [pidFile], {signal: abort.signal});
  const outcome = assert.rejects(job);
  const pid = await frontend();
  assert.equal(pgid(pid), pid, '前端应当是自己进程组的组长');
  assert.notEqual(pgid(pid), pgid(process.pid));
  abort.abort(); await outcome;
});

test('成功时返回输出，并且不留下信号监听', {skip: !unix}, async t => {
  const {dir} = await fixture(t);
  const ok = path.join(dir, 'ok');
  await fs.writeFile(ok, '#!/bin/sh\necho compiled\n', {mode: 0o700});
  const before = process.listenerCount('SIGTERM');
  assert.deepEqual(await runNativeCompiler(ok, [], {timeout: 5000}), {stdout: 'compiled\n', stderr: ''});
  assert.equal(activeCompileCount(), 0);
  assert.equal(process.listenerCount('SIGTERM'), before);
});

test('编译失败时带退出码，killed 为 false', {skip: !unix}, async t => {
  const {dir} = await fixture(t);
  const bad = path.join(dir, 'bad');
  await fs.writeFile(bad, '#!/bin/sh\necho broken >&2\nexit 3\n', {mode: 0o700});
  await assert.rejects(runNativeCompiler(bad, []), e => e.code === 3 && e.killed === false && e.stderr === 'broken\n');
});

for (const [mode, detach, label] of [
  ['cooperative', false, 'driver 收到 SIGINT 自己结束前端'],
  ['ignore', false, 'driver 不理 SIGINT，兜底 SIGKILL 结束两者'],
  ['leave', true, 'driver 先退出、前端不占管道，结束时补刀'],
  ['leave', false, 'driver 先退出、前端占着管道，兜底 SIGKILL'],
]) {
  test(`超时：${label}；错误和 execFile 一样标成 SIGTERM`, {skip: !unix}, async t => {
    const {compiler, pidFile, frontend} = await fixture(t, mode, {detach});
    const started = Date.now();
    const job = runNativeCompiler(compiler, [pidFile], {timeout: 1500});
    const outcome = assert.rejects(job, e => e.killed === true && e.signal === 'SIGTERM');
    const pid = await frontend();
    await outcome;
    assert.ok(Date.now() - started < 7000, '超时后没有及时返回');
    assert.ok(await until(() => !alive(pid)), '超时后前端还活着');
    assert.equal(activeCompileCount(), 0);
  });
}

test('取消时立即结束 driver 和前端', {skip: !unix}, async t => {
  const {compiler, pidFile, frontend} = await fixture(t, 'ignore');
  const abort = new AbortController();
  const job = runNativeCompiler(compiler, [pidFile], {signal: abort.signal});
  const outcome = assert.rejects(job, e => e.name === 'AbortError' && e.killed === true);
  const pid = await frontend();
  const started = Date.now();
  abort.abort();
  await outcome;
  assert.ok(Date.now() - started < 1000, '取消后没有及时返回');
  assert.ok(await until(() => !alive(pid)), '取消后前端还活着');
});

async function parent(t, {app}) {
  const {dir, compiler, pidFile, frontend} = await fixture(t);
  const script = path.join(dir, 'server.mjs');
  const appCode = {
    none: '',
    once: `process.once('SIGTERM', () => { console.log('app-handler'); setTimeout(() => { console.log('graceful-done'); process.exit(0); }, 300); });`,
    exit: '',
    group: '',
  }[app];
  await fs.writeFile(script, [
    `import {runNativeCompiler} from ${JSON.stringify(helper)};`,
    appCode,
    `runNativeCompiler(${JSON.stringify(compiler)}, [${JSON.stringify(pidFile)}], {timeout: 60000})`,
    `  .then(() => console.log('compiled'), () => console.log('compile-stopped'));`,
    app === 'exit' ? `process.on('message', () => process.exit(0));` : '',
    `setInterval(() => {}, 1000);`,
  ].join('\n'));
  const child = spawn(process.execPath, [script], {detached: app === 'group', stdio: ['ignore', 'pipe', 'inherit', ...(app === 'exit' ? ['ipc'] : [])]});
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  let stdout = '';
  child.stdout.on('data', d => { stdout += d; });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({code, signal})));
  const pid = await frontend();
  if (app === 'exit') child.send('exit');
  else if (app === 'group') { await new Promise(r => setTimeout(r, 500)); process.kill(-child.pid, 'SIGTERM'); }
  else child.kill('SIGTERM');
  const result = await exited;
  return {pid, result, stdout: () => stdout};
}

test('服务启动早期收到 SIGTERM：结束编译，再按默认行为退出', {skip: !unix}, async t => {
  const {pid, result} = await parent(t, {app: 'none'});
  assert.equal(result.signal, 'SIGTERM');
  assert.ok(await until(() => !alive(pid)), '服务退出后前端成了孤儿');
});

test('应用用 process.once 注册关闭处理：只结束编译，优雅关闭不被打断', {skip: !unix}, async t => {
  const {pid, result, stdout} = await parent(t, {app: 'once'});
  assert.equal(result.code, 0);
  assert.match(stdout(), /app-handler/);
  assert.match(stdout(), /graceful-done/);
  assert.ok(await until(() => !alive(pid)), '应用关闭后前端成了孤儿');
});

test('对服务整个进程组发 SIGTERM（测试套件收尾就是这样）：driver 先死、前端被收养，也要结束', {skip: !unix}, async t => {
  const {pid, result} = await parent(t, {app: 'group'});
  assert.equal(result.signal, 'SIGTERM');
  assert.ok(await until(() => !alive(pid)), '整组 SIGTERM 后前端成了孤儿');
});

test('编译中 process.exit()：前端也结束', {skip: !unix}, async t => {
  const {pid, result} = await parent(t, {app: 'exit'});
  assert.equal(result.code, 0);
  assert.ok(await until(() => !alive(pid)), 'process.exit 后前端成了孤儿');
});

// 真 swiftc：用全新的模块缓存编收纳窗口组件，等 swift-frontend 出现后取消，命令行里带本次目录的进程都要结束。
const swiftc = '/usr/bin/swiftc';
const hasSwift = process.platform === 'darwin' && spawnSync('/usr/bin/xcrun', ['--find', 'swiftc'], {stdio: 'ignore'}).status === 0;
test('真 swiftc：取消后 driver 和 swift-frontend 都不残留', {skip: !hasSwift && '需要 macOS 命令行工具', timeout: 60000}, async t => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sg-native-compile-real-')));
  const ours = () => spawnSync('/usr/bin/pgrep', ['-f', dir], {encoding: 'utf8'}).stdout.split(/\s+/).filter(Boolean).map(Number);
  t.after(async () => { for (const p of ours()) { try { process.kill(p, 'SIGKILL'); } catch {} } await fs.rm(dir, {recursive: true, force: true}); });
  const source = fileURLToPath(new URL('../server/file-intake/window.swift', import.meta.url));
  const abort = new AbortController();
  const job = runNativeCompiler(swiftc, ['-module-cache-path', path.join(dir, 'module-cache'), source, '-o', path.join(dir, 'out'), '-framework', 'Cocoa', '-framework', 'WebKit'], {signal: abort.signal, timeout: 120000});
  let settled = false; const outcome = job.then(() => 'compiled', e => e).finally(() => { settled = true; });
  const frontendSeen = await until(() => settled || spawnSync('/usr/bin/pgrep', ['-f', 'swift-frontend.*' + dir]).status === 0, 20000);
  if (settled || !frontendSeen) { t.skip('编译太快，没赶上 swift-frontend 运行中'); await outcome; return; }
  abort.abort();
  const result = await outcome;
  assert.equal(result?.name, 'AbortError');
  assert.ok(await until(() => ours().length === 0, 5000), '取消后仍有进程在用本次目录：' + ours().join(','));
});
