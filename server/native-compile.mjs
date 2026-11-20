// 本机 Swift 组件编译：让编译器整组进程跟着服务一起结束。
//
// swiftc 会再启动 swift-frontend 和链接器。用 execFile 时，超时或服务退出只结束
// swiftc 本身，子进程会变成孤儿继续写模块缓存和输出文件。这里让编译在自己的进程组里
// 运行，超时、取消、服务退出时结束整组。
//
// 服务启动早期（还没注册自己的关闭处理时）收到 SIGTERM/SIGINT/SIGHUP：先结束编译组，
// 再按系统默认行为退出。之后应用注册了自己的处理，这里只结束编译组，不替应用决定退出。
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
const active = new Set();
let hooked = false;

const killGroup = (child, signal) => {
  // 只在编译器主进程还没被回收时发信号：此时它的进程号、也就是组号，一定还属于这次编译。
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, signal); } catch {}
};
const killAll = signal => { for (const child of active) killGroup(child, signal); };
const onExit = () => killAll('SIGKILL');
const onSignal = signal => {
  killAll('SIGKILL');
  if (process.listenerCount(signal) === 1) {
    unhook();
    process.kill(process.pid, signal);
  }
};
const handlers = Object.fromEntries(signals.map(signal => [signal, () => onSignal(signal)]));

function hook() {
  if (hooked) return;
  hooked = true;
  process.on('exit', onExit);
  for (const signal of signals) process.on(signal, handlers[signal]);
}
function unhook() {
  if (!hooked) return;
  hooked = false;
  process.off('exit', onExit);
  for (const signal of signals) process.off(signal, handlers[signal]);
}

// 与 promisify(execFile) 相同的调用方式和结果：{stdout, stderr}；失败时错误带
// code、killed、signal、stdout、stderr。超时按 execFile 的习惯报 killed=true、signal='SIGTERM'。
export function runInProcessGroup(program, args = [], {timeout = 0, maxBuffer = 1024 * 1024, signal, cwd, env} = {}) {
  if (process.platform === 'win32') return execFileAsync(program, args, {timeout, maxBuffer, signal, cwd, env});
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('The operation was aborted'), {name: 'AbortError', code: 'ABORT_ERR'}));
      return;
    }
    let child;
    try { child = spawn(program, args, {detached: true, stdio: ['ignore', 'pipe', 'pipe'], cwd, env}); }
    catch (e) { reject(e); return; }
    const out = [], err = [];
    let bytes = 0, reason = null, timer, graceTimer;
    const stop = (why, first) => {
      if (reason) return;
      reason = why;
      killGroup(child, first);
      if (first !== 'SIGKILL') graceTimer = setTimeout(() => killGroup(child, 'SIGKILL'), 2000);
    };
    const collect = list => chunk => {
      bytes += chunk.length;
      if (bytes > maxBuffer) stop('maxBuffer', 'SIGKILL');
      else list.push(chunk);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    const onAbort = () => stop('abort', 'SIGKILL');
    signal?.addEventListener('abort', onAbort, {once: true});
    if (timeout > 0) timer = setTimeout(() => stop('timeout', 'SIGTERM'), timeout);
    if (child.pid) { active.add(child); hook(); }
    const finish = () => {
      clearTimeout(timer); clearTimeout(graceTimer);
      signal?.removeEventListener('abort', onAbort);
      active.delete(child);
      if (!active.size) unhook();
    };
    child.on('error', e => { finish(); reject(e); });
    child.on('close', (code, exitSignal) => {
      finish();
      const stdout = Buffer.concat(out).toString(), stderr = Buffer.concat(err).toString();
      if (!reason && code === 0) { resolve({stdout, stderr}); return; }
      let e;
      if (reason === 'abort') e = Object.assign(new Error('The operation was aborted'), {name: 'AbortError', code: 'ABORT_ERR'});
      else if (reason === 'maxBuffer') e = Object.assign(new RangeError('stdout or stderr maxBuffer length exceeded'), {code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'});
      else e = new Error('Command failed: ' + [program, ...args].join(' ') + (stderr ? '\n' + stderr : ''));
      Object.assign(e, {
        killed: reason !== null,
        signal: reason === 'timeout' ? 'SIGTERM' : exitSignal,
        stdout, stderr,
      });
      if (e.code === undefined) e.code = code;
      reject(e);
    });
  });
}

// 测试用：当前还在运行的编译数。
export const activeCompileCount = () => active.size;
