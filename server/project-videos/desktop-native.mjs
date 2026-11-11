import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {constants} from 'node:fs';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';

const sources = {
  desktop:{source:path.join(import.meta.dirname,'desktop-native.swift'),cache:'video-desktop-native',frameworks:['AppKit','CoreGraphics','SystemConfiguration']},
  vision:{source:path.join(import.meta.dirname,'../project-assets/head-vision.swift'),cache:'asset-head-vision',frameworks:['ImageIO','Vision']},
};
const PROTOCOL = 1;
const MAX_INPUT = 1024 * 1024, MAX_OUTPUT = 64 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const error = (code, message, status = 503, extra = {}) => Object.assign(new Error(message), {code, status, ...extra});
const reasons = {
  APPLICATION_CLOSING: '桌面组件正在关闭',
  DESKTOP_PLATFORM_UNAVAILABLE: '此环境不支持本机 Mac 桌面操作',
  DESKTOP_SESSION_UNAVAILABLE: '当前进程不属于已登录的本机桌面会话',
  NATIVE_HELPER_UNAVAILABLE: '本机桌面组件尚未准备好，请通过用户操作重试',
  NATIVE_COMPILER_UNAVAILABLE: '系统现有 Swift 编译工具不可用，未安装任何组件',
  NATIVE_TIMEOUT: '本机桌面组件执行超时',
  NATIVE_EXIT_UNSETTLED: '桌面组件退出尚未确认',
  NATIVE_FAILED: '本机桌面组件未正常完成',
  NATIVE_PROTOCOL_ERROR: '本机桌面组件回执无效',
  CLIPBOARD_CHANGED: '剪贴板在操作前已变化，未覆盖',
  CLIPBOARD_WRITE_FAILED: '未取得文件剪贴板写入回执，请核对剪贴板',
  INVALID_FILES: '请选择有效的绝对文件路径',
  EMPTY_FILES: '没有可操作的文件，未写入剪贴板',
  FILE_UNAVAILABLE: '部分文件已不可用，未执行桌面操作',
  INVALID_CHANGE_COUNT: '剪贴板版本无效',
};
const fault = (code, extra) => error(code, reasons[code] || reasons.NATIVE_FAILED,
  ['CLIPBOARD_CHANGED', 'CLIPBOARD_WRITE_FAILED'].includes(code) ? 409 :
    ['INVALID_FILES', 'EMPTY_FILES', 'INVALID_CHANGE_COUNT'].includes(code) ? 400 : 503, extra);
const unavailable = e => ({clipboard: {available: false, code: e.code, reason: e.message},
  revealMany: {available: false, code: e.code, reason: e.message}});

/**
 * runner is spawn-compatible: (executable, argv, options) => ChildProcess.
 * Every invocation is shell:false; JSON is written exclusively to stdin.
 * Store/router owns path authorization, identity rechecks and durable actions.
 */
export class ProjectVideoDesktopNative {
  constructor({directory, runner = spawn, platform = process.platform, variant = 'desktop'} = {}) {
    this.directory = typeof directory === 'string' && path.isAbsolute(directory) ? directory : null;
    this.component = sources[variant] ?? sources.desktop;
    this.runner = runner;
    this.platform = platform;
    this.children = new Map();
    this.pending = new Set();
    this.preparing = null;
    this.closing = false;
  }

  assertOpen() { if (this.closing) throw fault('APPLICATION_CLOSING'); }
  track(fn) {
    const work = Promise.resolve().then(() => { this.assertOpen(); return fn(); });
    this.pending.add(work);
    work.then(() => this.pending.delete(work), () => this.pending.delete(work));
    return work;
  }

  async eligible() {
    this.assertOpen();
    if (this.platform !== 'darwin' || process.env.MEDIA_CONTAINER === '1' ||
        process.env.container || process.env.CONTAINER === '1') throw fault('DESKTOP_PLATFORM_UNAVAILABLE');
    const uid = process.geteuid?.();
    if (!Number.isSafeInteger(uid) || uid <= 0 || process.getuid?.() !== uid) throw fault('DESKTOP_SESSION_UNAVAILABLE');
    // Only a numeric owner ID is read, never a username or credential.
    const result = await this.run('/usr/bin/stat', ['-f', '%u', '/dev/console'], '', 1500);
    if (result.code !== 0 || result.signal || !/^\d+\s*$/.test(result.stdout) || Number(result.stdout) !== uid) throw fault('DESKTOP_SESSION_UNAVAILABLE');
  }

  run(program, args, input, timeout, {mutation = false, cwd, env = process.env} = {}) {
    this.assertOpen();
    return new Promise((resolve, reject) => {
      let child;
      const runner = this.runner;
      try { child = runner(program, args, {shell: false, detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], cwd, env}); }
      catch { reject(fault('NATIVE_FAILED')); return; }
      // Capture ownership from this spawn, never from a later runner setting or
      // a supplied runner's PID. Detached real spawns own exactly this PGID.
      const ownedPgid = runner === spawn && process.platform !== 'win32' &&
        Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null;
      let stdout = '', bytes = 0, terminalError, timeoutTimer, killTimer, exitTimer, pollTimer;
      let settled = false, finished = false, stopping = false, expired = false, parentResult;
      let exitKnown;
      const exited = new Promise(resolve => { exitKnown = resolve; });
      const fail = code => { terminalError ||= fault(code, {effectUnknown: mutation}); };
      const kill = signal => {
        // swiftc also launches swift-frontend/linker. Own a process group so a
        // timeout or close terminates the entire compiler invocation.
        try {
          if (ownedPgid) process.kill(-ownedPgid, signal);
          else child.kill(signal);
        } catch {}
      };
      const groupGone = () => {
        if (!ownedPgid) return true; // Spawn failure, or the injected runner's close contract.
        try { process.kill(-ownedPgid, 0); return false; }
        catch (e) { return e.code === 'ESRCH'; }
        // EPERM/unknown errors and macOS zombie groups are NOT exit proof.
      };
      const clearTimers = () => {
        clearTimeout(timeoutTimer); clearTimeout(killTimer); clearTimeout(exitTimer); clearTimeout(pollTimer);
      };
      const finish = () => {
        if (finished || !parentResult || !groupGone()) return finished;
        finished = true;
        clearTimers();
        this.children.delete(child);
        exitKnown(true);
        if (!settled) {
          settled = true;
          if (terminalError) reject(terminalError);
          else resolve({stdout, ...parentResult});
        }
        return true;
      };
      const poll = () => {
        if (finish() || expired) return;
        pollTimer = setTimeout(poll, 25);
      };
      const stop = code => {
        if (code) fail(code);
        if (finish() || stopping) return;
        stopping = true;
        clearTimeout(timeoutTimer);
        kill('SIGTERM');
        if (finished) return;
        killTimer = setTimeout(() => { kill('SIGKILL'); finish(); }, 200);
        exitTimer = setTimeout(() => {
          if (finish()) return;
          expired = true;
          clearTimers();
          // Keep the invocation tracked, even if its parent has closed. A sent
          // KILL, ambiguous group probe or deadline cannot establish group exit.
          if (!settled) { settled = true; reject(fault('NATIVE_EXIT_UNSETTLED', {effectUnknown: mutation})); }
          exitKnown(false);
        }, 1200);
        if (ownedPgid) poll();
      };
      this.children.set(child, {stop, exited});
      child.once('error', () => fail('NATIVE_FAILED'));
      child.once('close', (code, signal) => {
        parentResult = {code, signal};
        // Normal compiler completion must settle descendants too. Parent close
        // must never cancel escalation while an owned group is still present.
        if (!finish()) stop();
      });
      child.stdout?.on('data', b => {
        bytes += Buffer.byteLength(b);
        if (bytes > MAX_OUTPUT) stop('NATIVE_PROTOCOL_ERROR'); else stdout += b.toString('utf8');
      });
      // Drain but never expose native/compiler stderr or paths in errors.
      child.stderr?.on('data', b => { bytes += Buffer.byteLength(b); if (bytes > MAX_OUTPUT) stop('NATIVE_PROTOCOL_ERROR'); });
      child.stdin?.on('error', () => stop('NATIVE_FAILED'));
      timeoutTimer = setTimeout(() => stop('NATIVE_TIMEOUT'), timeout);
      try { child.stdin.end(input); } catch { stop('NATIVE_FAILED'); }
    });
  }

  async sourceInfo() {
    if (!this.directory) throw fault('NATIVE_HELPER_UNAVAILABLE');
    const source = await fs.readFile(this.component.source).catch(() => { throw fault('NATIVE_HELPER_UNAVAILABLE'); });
    const sourceHash = hash(source);
    const key = hash(`${PROTOCOL}:${process.arch}:${sourceHash}`);
    return {source, sourceHash, key, cache: path.join(this.directory,this.component.cache),
      binaryName: `helper-${key}`, manifestName: `helper-${key}.json`};
  }

  async privateCache(info, create = false) {
    if (create) await fs.mkdir(info.cache, {recursive: true, mode: 0o700});
    const st = await fs.lstat(info.cache);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.geteuid?.() || (st.mode & 0o022)) throw fault('NATIVE_HELPER_UNAVAILABLE');
    // /var on macOS can itself be a system symlink; anchor to the caller's real directory.
    if (await fs.realpath(info.cache) !== path.join(await fs.realpath(this.directory),this.component.cache)) throw fault('NATIVE_HELPER_UNAVAILABLE');
  }

  async readOwned(file, limit, executable = false) {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.uid !== process.geteuid?.() || st.size > limit || (st.mode & 0o022) ||
          executable && !(st.mode & 0o100)) throw fault('NATIVE_HELPER_UNAVAILABLE');
      return await handle.readFile();
    } finally { await handle.close(); }
  }

  async cached(info) {
    try {
      await this.privateCache(info);
      const manifest = JSON.parse((await this.readOwned(path.join(info.cache, info.manifestName), 4096)).toString('utf8'));
      if (manifest.protocol !== PROTOCOL || manifest.sourceHash !== info.sourceHash || manifest.arch !== process.arch) return null;
      const binary = path.join(info.cache, info.binaryName);
      if (hash(await this.readOwned(binary, 32 * 1024 * 1024, true)) !== manifest.binaryHash) return null;
      return binary;
    } catch { return null; }
  }

  async prepare(info) {
    this.assertOpen();
    const cached = await this.cached(info);
    if (cached) return cached;
    // xcode-select -p is read-only. Never run the /usr/bin/swiftc installation shim.
    const selected = await this.run('/usr/bin/xcode-select', ['-p'], '', 1500);
    const developer = selected.stdout.trim();
    if (selected.code !== 0 || selected.signal || !path.isAbsolute(developer) || /[\0\r\n]/.test(developer)) throw fault('NATIVE_COMPILER_UNAVAILABLE');
    let compiler;
    for (const candidate of [path.join(developer, 'usr/bin/swiftc'), path.join(developer, 'Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc')]) {
      try { if ((await fs.stat(candidate)).isFile()) { await fs.access(candidate, constants.X_OK); compiler = candidate; break; } } catch {}
    }
    if (!compiler) throw fault('NATIVE_COMPILER_UNAVAILABLE');
    let sdk;
    for (const candidate of [path.join(developer, 'SDKs/MacOSX.sdk'), path.join(developer, 'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk')]) {
      try { if ((await fs.stat(candidate)).isDirectory()) { sdk = candidate; break; } } catch {}
    }
    if (!sdk) throw fault('NATIVE_COMPILER_UNAVAILABLE');
    this.assertOpen();
    await this.privateCache(info, true);
    const build = await fs.mkdtemp(path.join(info.cache, '.build-'));
    let scratch, unsettled = false;
    try {
      // This system Swift traps even for --version if TMPDIR contains Unicode.
      // Keep compiler scratch ASCII and private; outputs/cache stay in directory.
      scratch = await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'sg-vn-'));
      const source = path.join(build, 'main.swift'), binary = path.join(build, 'helper');
      await fs.writeFile(source, info.source, {flag: 'wx', mode: 0o600});
      const moduleCache = path.join(build, 'modules');
      const result = await this.run(compiler, ['-sdk', sdk, '-module-cache-path', moduleCache, source, '-o', binary,
        ...this.component.frameworks.flatMap(name=>['-framework',name])], '', 45000,
      {cwd: build, env: {...process.env, TMPDIR: scratch + path.sep, CLANG_MODULE_CACHE_PATH: moduleCache, SWIFT_MODULECACHE_PATH: moduleCache}});
      if (result.code !== 0 || result.signal) throw fault('NATIVE_COMPILER_UNAVAILABLE');
      this.assertOpen();
      await fs.chmod(binary, 0o700);
      const binaryHash = hash(await this.readOwned(binary, 32 * 1024 * 1024, true));
      const manifest = path.join(build, 'manifest.json');
      await fs.writeFile(manifest, JSON.stringify({protocol: PROTOCOL, sourceHash: info.sourceHash, arch: process.arch, binaryHash}), {flag: 'wx', mode: 0o600});
      this.assertOpen();
      await fs.rename(binary, path.join(info.cache, info.binaryName));
      await fs.rename(manifest, path.join(info.cache, info.manifestName));
      return path.join(info.cache, info.binaryName);
    } catch (e) {
      unsettled = e.code === 'NATIVE_EXIT_UNSETTLED';
      throw e;
    } finally {
      // Retain this invocation's private files if process exit is unknown.
      if (!unsettled) {
        await fs.rm(build, {recursive: true, force: true});
        if (scratch) await fs.rm(scratch, {recursive: true, force: true});
      }
    }
  }

  async helper({prepare = false} = {}) {
    await this.eligible();
    const info = await this.sourceInfo();
    let binary = await this.cached(info);
    if (!binary && prepare) {
      if (!this.preparing) {
        this.preparing = this.prepare(info).finally(() => { this.preparing = null; });
      }
      binary = await this.preparing;
    }
    if (!binary) throw fault('NATIVE_HELPER_UNAVAILABLE');
    this.assertOpen();
    return binary;
  }

  async invoke(binary, request) {
    const mutation = ['copy-files', 'reveal-files'].includes(request.operation);
    const input = JSON.stringify({protocol: PROTOCOL, ...request});
    if (Buffer.byteLength(input) > MAX_INPUT) throw fault('INVALID_FILES');
    const result = await this.run(binary, [], input, request.operation==='detect-face'?1500:5000, {mutation});
    let data;
    try { data = JSON.parse(result.stdout); } catch { throw fault('NATIVE_PROTOCOL_ERROR', {effectUnknown: mutation}); }
    if (result.signal || data?.protocol !== PROTOCOL || typeof data.ok !== 'boolean') throw fault('NATIVE_PROTOCOL_ERROR', {effectUnknown: mutation});
    if (!data.ok) {
      const code = Object.hasOwn(reasons, data.code) ? data.code : 'NATIVE_FAILED';
      throw fault(code, {effectUnknown: mutation && !['CLIPBOARD_CHANGED', 'EMPTY_FILES', 'INVALID_FILES', 'FILE_UNAVAILABLE', 'INVALID_CHANGE_COUNT', 'DESKTOP_SESSION_UNAVAILABLE', 'DESKTOP_PLATFORM_UNAVAILABLE'].includes(code)});
    }
    if (result.code !== 0) throw fault('NATIVE_FAILED', {effectUnknown: mutation});
    return data;
  }

  capabilities() {
    return this.track(async () => {
      try {
        const data = await this.invoke(await this.helper(), {operation: 'capabilities'});
        const valid = c => c && typeof c.available === 'boolean' && (c.available || Object.hasOwn(reasons, c.code));
        if (!valid(data.clipboard) || !valid(data.revealMany)) throw fault('NATIVE_PROTOCOL_ERROR');
        const dto = c => c.available ? {available: true} : {available: false, code: c.code, reason: reasons[c.code]};
        return {clipboard: dto(data.clipboard), revealMany: dto(data.revealMany)};
      } catch (e) { return unavailable(Object.hasOwn(reasons, e.code) ? e : fault('NATIVE_HELPER_UNAVAILABLE')); }
    }).catch(e => unavailable(e));
  }

  clipboardVersion() {
    return this.track(async () => {
      const data = await this.invoke(await this.helper({prepare: true}), {operation: 'clipboard-version'});
      if (!Number.isSafeInteger(data.changeCount) || data.changeCount < 0) throw fault('NATIVE_PROTOCOL_ERROR');
      return data.changeCount;
    });
  }

  files(paths) {
    if (!Array.isArray(paths) || paths.length > 1000 || paths.some(p => typeof p !== 'string' || !path.posix.isAbsolute(p) || p.includes('\0') || Buffer.byteLength(p) > 8192)) throw fault('INVALID_FILES');
    if (!paths.length) throw fault('EMPTY_FILES');
    if (Buffer.byteLength(JSON.stringify(paths)) > MAX_INPUT - 256) throw fault('INVALID_FILES');
    return [...paths];
  }

  copyFiles(paths, {expectedChangeCount} = {}) {
    return this.track(async () => {
      const files = this.files(paths);
      if (!Number.isSafeInteger(expectedChangeCount) || expectedChangeCount < 0) throw fault('INVALID_CHANGE_COUNT');
      const data = await this.invoke(await this.helper({prepare: true}), {operation: 'copy-files', paths: files, expectedChangeCount});
      if (data.ack !== 'written' || data.count !== files.length || !Number.isSafeInteger(data.changeCount) || data.changeCount < 0) throw fault('NATIVE_PROTOCOL_ERROR', {effectUnknown: true});
      return {ack: 'written', count: data.count, changeCount: data.changeCount};
    });
  }

  revealFiles(paths) {
    return this.track(async () => {
      const files = this.files(paths);
      const data = await this.invoke(await this.helper({prepare: true}), {operation: 'reveal-files', paths: files});
      if (data.ack !== 'dispatched' || data.count !== files.length) throw fault('NATIVE_PROTOCOL_ERROR', {effectUnknown: true});
      return {ack: 'dispatched', count: data.count};
    });
  }

  detectFace(snapshot) {
    return this.track(async () => {
      if(this.component!==sources.vision)throw fault('NATIVE_PROTOCOL_ERROR');
      const files=this.files([snapshot]);
      // App startup may prepare the helper; do not compile on a crop request.
      const data=await this.invoke(await this.helper(),{operation:'detect-face',paths:files});
      if(!['unsupported','not_found','decoded'].includes(data.status))throw fault('NATIVE_PROTOCOL_ERROR');
      return data;
    });
  }

  close() {
    if (this.closeWork) return this.closeWork;
    this.closing = true;
    for (const {stop} of this.children.values()) stop('APPLICATION_CLOSING');
    this.closeWork = (async () => {
      let timer;
      try {
        await Promise.race([Promise.allSettled([...this.pending, ...[...this.children.values()].map(c => c.exited)]), new Promise((_, reject) => {
          timer = setTimeout(() => reject(fault('NATIVE_EXIT_UNSETTLED')), 2000);
        })]);
        if (this.children.size) throw fault('NATIVE_EXIT_UNSETTLED');
      } finally { clearTimeout(timer); }
    })();
    return this.closeWork;
  }
}
