// Synchronous --require also observes the Node 22 CLI test-runner process.
// Runner-owned preload. Never change detached/stdio/ref, send a signal, add an
// error listener, or replace the original spawn result/error/event semantics.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const {randomUUID} = require('node:crypto');
const {syncBuiltinESMExports} = require('node:module');
const {createHook} = require('node:async_hooks');
const {isMainThread} = require('node:worker_threads');
const {OBSERVATION_ENV, PARENT_ENV, PROTOCOL, parseRuns} = require('./test-resource-ledger.cjs');

let scopes;
try { scopes = parseRuns(process.env[OBSERVATION_ENV]); } catch { scopes = []; }
if (scopes.length) {
  const nodeId = randomUUID();
  const writers = scopes.map(scope => {
    try { return {...scope, fd:fs.openSync(path.join(scope.directory, `${nodeId}.jsonl`), 'wx', 0o600), seq:0, healthy:true}; }
    catch { return {...scope, fd:null, seq:0, healthy:false}; }
  });
  const emit = (event, details = {}, extra = () => ({})) => {
    for (const writer of writers) {
      const record = {protocol:PROTOCOL, token:writer.token, nodeId, seq:++writer.seq, healthy:writer.healthy, event, ...details, ...extra(writer)};
      try {
        if (writer.fd === null) continue;
        const buffer = Buffer.from(JSON.stringify(record) + '\n');
        let offset = 0;
        while (offset < buffer.length) offset += fs.writeSync(writer.fd, buffer, offset, buffer.length - offset);
      } catch { writer.healthy = false; }
    }
  };
  let parent = null;
  try { parent = JSON.parse(process.env[PARENT_ENV] ?? 'null'); } catch {}
  emit('start', {pid:process.pid, ppid:process.ppid, mainThread:isMainThread, parent,
    testRunner:process.execArgv.includes('--test') && !process.env.NODE_TEST_CONTEXT,
    testWorker:process.env.NODE_TEST_CONTEXT === 'child-v8'});
  const records = new WeakMap();
  const originalSpawn = cp.ChildProcess.prototype.spawn;
  const originalEmit = cp.ChildProcess.prototype.emit;
  const originalKill = cp.ChildProcess.prototype.kill;
  function prepareSpawn(options, sync = false) {
    const spawnId = randomUUID();
    const get = key => options?.envPairs?.find(pair => pair.startsWith(`${key}=`))?.slice(key.length + 1);
    let inherited = [];
    try { inherited = parseRuns(get(OBSERVATION_ENV)); } catch {}
    emit('spawn-intent', {spawnId, sync, executable:typeof options?.file === 'string' ? path.basename(options.file) : null, detached:options?.detached === true}, writer => ({
      inherited:inherited.some(scope => scope.token === writer.token && scope.directory === writer.directory),
    }));
    // Annotate only an already-inherited runner context. An explicit isolated
    // environment stays isolated and is classified UNKNOWN, never repaired here.
    let observedOptions = options;
    if (inherited.length && Array.isArray(options?.envPairs)) {
      observedOptions = {...options, envPairs:[...options.envPairs.filter(pair => !pair.startsWith(`${PARENT_ENV}=`)),
        `${PARENT_ENV}=${JSON.stringify({nodeId, spawnId})}`]};
    }
    return {spawnId, observedOptions};
  }
  cp.ChildProcess.prototype.spawn = function(options) {
    const {spawnId, observedOptions} = prepareSpawn(options);
    records.set(this, {spawnId});
    try { return originalSpawn.call(this, observedOptions); }
    catch (error) { emit('spawn-rejected', {spawnId, pid:this.pid ?? null}); throw error; }
  };
  cp.ChildProcess.prototype.emit = function(event, ...args) {
    const record = records.get(this);
    if (record) {
      const fields = {spawnId:record.spawnId, pid:this.pid ?? null};
      if (event === 'spawn') emit('child-spawn', fields);
      if (event === 'error') emit('child-error', {...fields, errorCode:args[0]?.code ?? null});
      if (event === 'exit' || event === 'close') emit(`child-${event}`, {...fields, code:args[0], signal:args[1]});
    }
    return originalEmit.call(this, event, ...args);
  };
  cp.ChildProcess.prototype.kill = function(...args) {
    const result = originalKill.apply(this, args), record = records.get(this);
    if (record) emit('child-stop-request', {spawnId:record.spawnId, pid:this.pid ?? null,
      signal:args[0] ?? 'SIGTERM', accepted:result});
    return result;
  };
  // Node 22's normalized sync binding is shared by spawnSync/execFileSync/
  // execSync. Observe its original return before public APIs convert/throw it.
  // This does not make an unobserved native child a proven descendant boundary.
  try {
    const binding = process.binding('spawn_sync'), original = binding.spawn;
    binding.spawn = function(options) {
      const {spawnId, observedOptions} = prepareSpawn(options, true);
      try {
        const result = original.call(this, observedOptions);
        emit('sync-exit', {spawnId, pid:result.pid ?? null, code:result.status, signal:result.signal ?? null, errorCode:result.error ?? null});
        return result;
      } catch (error) { emit('sync-throw', {spawnId}); throw error; }
    };
  } catch { emit('unsupported', {reason:'SYNC_OBSERVER_UNAVAILABLE'}); }
  syncBuiltinESMExports();
  createHook({init(_id, type) {
    if (type === 'WORKER') emit('unsupported', {reason:'WORKER_THREAD_UNQUALIFIED'});
  }}).enable();
  process.on('beforeExit', code => emit('before-exit', {code}));
  process.on('exit', code => emit('exit', {code, signal:null}));
}
