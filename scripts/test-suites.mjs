import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import ledger from './test-resource-ledger.cjs';
const {createObservation, inspectObservation} = ledger;
export const inheritTestObservation = ledger.inheritTestObservation;

const repo = fileURLToPath(new URL('..', import.meta.url));
export const DEFAULT_TIMEOUT_MS = 120_000;
const cloud = name => name.startsWith('cloud-') || name === 'device-enrollment.test.mjs';

export async function selectTests(suite = 'local', directory = path.join(repo, 'tests')) {
  if (!['local', 'cloud'].includes(suite)) throw Error('Suite must be local or cloud');
  const names = (await fs.readdir(directory, {withFileTypes:true})).filter(e => e.isFile() && e.name.endsWith('.test.mjs')).map(e => e.name).sort();
  const included = names.filter(name => cloud(name) === (suite === 'cloud'));
  return {suite, included, excluded:names.filter(name => !included.includes(name))};
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function groupAlive(pid) {
  try { process.kill(-pid, 0); return true; }
  catch (e) { if (e.code === 'ESRCH') return false; throw e; }
}

// Each child owns a fresh process group; never signal a discovered/unrelated PID.
// A failed normal shutdown is reported UNKNOWN and stops the suite; no force-exit.
export async function runTestFile(file, {cwd = repo, timeoutMs = DEFAULT_TIMEOUT_MS, graceMs = 5000, nodeArgs = [], env = process.env, output = chunk => process.stdout.write(chunk)} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(graceMs) || graceMs < 1) throw Error('Timeouts must be positive integer milliseconds');
  const posix = process.platform !== 'win32';
  const {scope, childEnv} = await createObservation(env);
  delete childEnv.NODE_TEST_CONTEXT; // This is a new runner, not the parent's test worker.
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', `--test-timeout=${timeoutMs}`, ...nodeArgs, file], {cwd, env:childEnv, detached:posix, stdio:['ignore','pipe','pipe']});
  const started = Date.now();
  let rawExit = null, timedOut = false, stopRequested = false, spawnError = null;
  const stop = () => {
    stopRequested = true;
    if (!child.pid) return;
    try { if (posix) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
  };
  child.stdout.on('data', output); child.stderr.on('data', output);
  child.once('exit', (code, signal) => { rawExit = {code, signal}; });
  const done = new Promise(resolve => {
    child.once('close', () => resolve());
    child.once('error', e => { spawnError = e.message; resolve(); });
  });
  let wallTimer;
  const deadline = new Promise(resolve => { wallTimer = setTimeout(() => { timedOut = true; stop(); resolve(); }, timeoutMs); });
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    await Promise.race([done, deadline]);
    clearTimeout(wallTimer);
    if (posix && child.pid && groupAlive(child.pid)) stop();
    const end = Date.now() + graceMs;
    const inspect = () => inspectObservation(scope, child.pid, {stopRequested, groupAbsent:posix && child.pid ? !groupAlive(child.pid) : false});
    let observation = await inspect();
    while (Date.now() < end && ((!rawExit && !spawnError) || (posix && child.pid && groupAlive(child.pid)) || observation.state === 'UNKNOWN')) {
      await sleep(Math.min(25, Math.max(1, end - Date.now())));
      observation = await inspect();
    }
    const groupAbsent = posix && child.pid ? !groupAlive(child.pid) : null;
    if (!rawExit && !spawnError || groupAbsent === false) observation = {...observation, state:'UNKNOWN', unknown:[...observation.unknown,
      {reason:groupAbsent === false ? 'OWNED_GROUP_STILL_ALIVE' : 'ROOT_EXIT_MISSING'}]};
    const observedResourcesClosed = !!(rawExit || spawnError) && observation.state !== 'UNKNOWN';
    const resourcesKnown = observedResourcesClosed && observation.state === 'KNOWN';
    if (!observedResourcesClosed) { child.unref(); child.stdout.destroy(); child.stderr.destroy(); }
    return {file, pid:child.pid ?? null, durationMs:Date.now()-started, timedOut, stopRequested, rawExit, spawnError, groupAbsent,
      resourcesKnown, observedResourcesClosed, resourceObservation:observation,
      passed:!timedOut && !stopRequested && !spawnError && rawExit?.code === 0 && observedResourcesClosed};
  } finally {
    clearTimeout(wallTimer); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
  }
}

export async function main(args = process.argv.slice(2)) {
  let suite = 'local', list = false, timeoutMs = DEFAULT_TIMEOUT_MS;
  const requested = [], nodeArgs = [];
  for (let i=0; i<args.length; i++) {
    const a = args[i];
    if (a === '--suite') suite = args[++i];
    else if (a === '--list') list = true;
    else if (a === '--timeout') timeoutMs = Number(args[++i]);
    else if (a === '--file') requested.push(args[++i]);
    else if (a === '--test-name-pattern') nodeArgs.push(`--test-name-pattern=${args[++i]}`);
    else throw Error(`Unknown argument: ${a}`);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw Error('Timeout must be positive integer milliseconds');
  const selection = await selectTests(suite);
  for (const f of requested) if (!selection.included.includes(f)) throw Error(`Not in ${suite} suite: ${f}`);
  const included = requested.length ? [...new Set(requested)].sort() : selection.included;
  console.log(JSON.stringify({...selection, included, timeoutMs, concurrency:1, cloudUi:'not selected; run explicitly when needed'}));
  if (list) return 0;
  let failed = false;
  for (const name of included) {
    console.log(`\n[${suite}] tests/${name}`);
    const result = await runTestFile(path.join('tests',name), {timeoutMs, nodeArgs});
    console.log('[test-file-result] ' + JSON.stringify(result));
    if (result.resourceObservation.state === 'LIMITED') console.error('[test-resource-coverage] LIMITED: observed direct external tools closed; opaque external descendants are not covered.');
    if (!result.passed) failed = true;
    if (!result.observedResourcesClosed || result.resourceObservation.state === 'UNKNOWN' || result.stopRequested || result.timedOut) return 1;
  }
  return failed ? 1 : 0;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(code => { process.exitCode = code; }).catch(e => { console.error(e.message); process.exitCode = 1; });
