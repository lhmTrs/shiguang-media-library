// 本机 Swift 组件编译：超时、取消、服务退出时，编译器和它启动的 swift-frontend 一起结束。
//
// swiftc（swift-driver）会把 swift-frontend 放进 frontend 自己新建的进程组，对 driver 或 driver
// 的组发信号都够不到 frontend。driver 收到 SIGINT 时会自己结束 frontend（SIGTERM、SIGHUP 不会）。
// 所以这里：
// 1. 先对 driver 发 SIGINT，让它自己收拾；
// 2. 同时记下 driver 当时的全部子孙进程（含启动时间），一段时间后还活着的用 SIGKILL 兜底，
//    driver 先退出、子孙被系统收养时也照样补；发信号前核对启动时间，不误伤复用了进程号的别的进程。
// 编译留在服务自己的进程组里（不 detached），对服务整组发的信号 driver 也能收到。
//
// 服务启动早期（应用还没注册自己的关闭处理）收到 SIGTERM/SIGINT/SIGHUP：先结束编译，再按系统默认
// 行为退出。应用已经注册了处理时，只结束编译，退出交给应用。
import {execFile, spawn, spawnSync} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'];
const GRACE_MS = 1500;
const active = new Set();
let hooked = false;

// 进程表快照：pid -> {ppid, started}；started 是 ps 的 lstart，用来确认还是同一个进程。
function table() {
  const r = spawnSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,lstart='], {encoding: 'utf8', env: {...process.env, LC_ALL: 'C'}});
  const rows = new Map();
  if (r.status !== 0 || typeof r.stdout !== 'string') return rows;
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (m) rows.set(Number(m[1]), {ppid: Number(m[2]), started: m[3]});
  }
  return rows;
}

const alive = child => child.exitCode === null && child.signalCode === null;

// 把 driver 现在的子孙并进 job.tree（只增不减：driver 退出后被收养的子孙也还在名单里）。
function remember(job, rows = table()) {
  if (!alive(job.child)) return rows;
  const queue = [job.child.pid];
  while (queue.length) {
    const parent = queue.shift();
    for (const [pid, row] of rows) {
      if (row.ppid !== parent || job.tree.has(pid)) continue;
      job.tree.set(pid, row.started);
      queue.push(pid);
    }
  }
  return rows;
}

function sweep(job, rows = table()) {
  for (const [pid, started] of job.tree) {
    const now = rows.get(pid);
    if (!now || now.started !== started) { job.tree.delete(pid); continue; }
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  if (alive(job.child)) { try { job.child.kill('SIGKILL'); } catch {} }
}

// graceful：先 SIGINT，GRACE_MS 后兜底；否则立即 SIGINT + SIGKILL（服务马上要退出时用）。
function stopJob(job, graceful) {
  const rows = remember(job);
  if (alive(job.child)) { try { job.child.kill('SIGINT'); } catch {} }
  if (!graceful) { sweep(job, rows); return; }
  clearTimeout(job.grace);
  job.grace = setTimeout(() => { remember(job); sweep(job); }, GRACE_MS);
}

const onExit = () => { for (const job of active) stopJob(job, false); };
const onSignal = signal => {
  // 本监听用 prependListener 放在最前，所以应用即使用 process.once 注册，这时也还在监听数里。
  const others = process.listenerCount(signal) > 1;
  for (const job of active) stopJob(job, false);
  if (!others) { unhook(); process.kill(process.pid, signal); }
};
const handlers = Object.fromEntries(signals.map(signal => [signal, () => onSignal(signal)]));

function hook() {
  if (hooked) return;
  hooked = true;
  process.on('exit', onExit);
  for (const signal of signals) process.prependListener(signal, handlers[signal]);
}
function unhook() {
  if (!hooked) return;
  hooked = false;
  process.off('exit', onExit);
  for (const signal of signals) process.off(signal, handlers[signal]);
}

const abortError = () => Object.assign(new Error('The operation was aborted'), {name: 'AbortError', code: 'ABORT_ERR'});

// 与 promisify(execFile) 相同的调用方式和结果：{stdout, stderr}；失败时错误带 code、killed、
// signal、stdout、stderr。超时按 execFile 的习惯报 killed=true、signal='SIGTERM'。
export function runNativeCompiler(program, args = [], {timeout = 0, maxBuffer = 1024 * 1024, signal, cwd, env} = {}) {
  if (process.platform === 'win32') return execFileAsync(program, args, {timeout, maxBuffer, signal, cwd, env});
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    let child;
    try { child = spawn(program, args, {stdio: ['ignore', 'pipe', 'pipe'], cwd, env}); }
    catch (e) { reject(e); return; }
    const job = {child, tree: new Map(), grace: null};
    const out = [], err = [];
    let bytes = 0, reason = null, timer;
    const stop = (why, graceful) => { if (reason) return; reason = why; stopJob(job, graceful); };
    const collect = list => chunk => {
      bytes += chunk.length;
      if (bytes > maxBuffer) stop('maxBuffer', false);
      else list.push(chunk);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    const onAbort = () => stop('abort', false);
    signal?.addEventListener('abort', onAbort, {once: true});
    if (timeout > 0) timer = setTimeout(() => stop('timeout', true), timeout);
    if (child.pid) { active.add(job); hook(); }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // 被结束的编译：driver 已退出、管道已关，再兜底一次，不留被收养的子孙。
      if (reason) { clearTimeout(job.grace); sweep(job); }
      active.delete(job);
      if (!active.size) unhook();
    };
    child.on('error', e => { finish(); reject(e); });
    child.on('close', (code, exitSignal) => {
      finish();
      const stdout = Buffer.concat(out).toString(), stderr = Buffer.concat(err).toString();
      if (!reason && code === 0) { resolve({stdout, stderr}); return; }
      let e;
      if (reason === 'abort') e = abortError();
      else if (reason === 'maxBuffer') e = Object.assign(new RangeError('stdout or stderr maxBuffer length exceeded'), {code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'});
      else e = new Error('Command failed: ' + [program, ...args].join(' ') + (stderr ? '\n' + stderr : ''));
      Object.assign(e, {killed: reason !== null, signal: reason === 'timeout' ? 'SIGTERM' : exitSignal, stdout, stderr});
      if (e.code === undefined) e.code = code;
      reject(e);
    });
  });
}

// 测试用：当前还在运行的编译数。
export const activeCompileCount = () => active.size;
