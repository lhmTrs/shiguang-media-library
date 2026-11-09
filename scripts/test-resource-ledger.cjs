const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {randomUUID} = require('node:crypto');

const OBSERVATION_ENV = 'SHIGUANG_TEST_RESOURCE_RUNS';
const PARENT_ENV = 'SHIGUANG_TEST_RESOURCE_PARENT';
const PROTOCOL = 1;
const preload = path.join(__dirname, 'test-resource-observer.cjs');

function parseRuns(value) {
  if (value === undefined) return [];
  const runs = JSON.parse(value);
  if (!Array.isArray(runs) || runs.some(run => !run || !path.isAbsolute(run.directory ?? '') || !/^[a-f0-9-]{36}$/.test(run.token ?? ''))) {
    throw Error('Invalid test resource observation context');
  }
  return runs;
}

async function createObservation(env) {
  const inherited = parseRuns(env[OBSERVATION_ENV]);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shiguang-test-resources-'));
  await fs.chmod(directory, 0o700);
  const scope = {directory, token:randomUUID()};
  const childEnv = {...env, [OBSERVATION_ENV]:JSON.stringify([...inherited, scope])};
  childEnv.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(preload)}`.trim();
  return {scope, childEnv};
}

// Exit/close receipts establish closure. PID/group absence is only an additional
// check in the runner, never a replacement for an inherited observation chain.
async function inspectObservation(scope, rootPid, {groupAbsent = false, stopRequested = false} = {}) {
  const unknown = [], nodes = new Map();
  const problem = (reason, details = {}) => unknown.push({reason, ...details});
  let names;
  try { names = await fs.readdir(scope.directory); }
  catch { return {protocol:PROTOCOL, state:'UNKNOWN', directory:scope.directory, processes:[], unknown:[{reason:'LEDGER_UNREADABLE'}]}; }
  for (const name of names.sort()) {
    try {
      if (!name.endsWith('.jsonl')) throw Error('Unexpected ledger entry');
      const text = await fs.readFile(path.join(scope.directory, name), 'utf8');
      if (!text.endsWith('\n')) throw Error('Incomplete ledger write');
      const events = text.trimEnd().split('\n').map(JSON.parse), first = events[0];
      if (first?.event !== 'start' || first.protocol !== PROTOCOL || first.token !== scope.token ||
          !Number.isSafeInteger(first.pid) || first.pid < 1 || name !== `${first.nodeId}.jsonl` || nodes.has(first.nodeId)) throw Error('Invalid ledger header');
      for (const [index, event] of events.entries()) {
        if (event.seq !== index + 1 || event.nodeId !== first.nodeId || event.healthy !== true) throw Error('Incomplete observation sequence');
      }
      nodes.set(first.nodeId, {start:first, events});
    } catch { problem('LEDGER_INCOMPLETE', {entry:name}); }
  }
  const roots = [...nodes.values()].filter(node => node.start.pid === rootPid && node.start.mainThread);
  if (roots.length !== 1) problem('ROOT_OBSERVER_MISSING');
  const attempts = new Map();
  for (const node of nodes.values()) {
    for (const event of node.events) {
      if (event.event === 'spawn-intent') attempts.set(event.spawnId, {parent:node, intent:event, events:node.events.filter(e => e.spawnId === event.spawnId)});
      if (event.event === 'unsupported') problem(event.reason, {pid:node.start.pid});
    }
  }
  const processes = [];
  for (const node of nodes.values()) {
    const start = node.start, parent = start.parent && attempts.get(start.parent.spawnId);
    const root = roots.includes(node);
    if (!root && (!parent || parent.parent.start.nodeId !== start.parent.nodeId)) problem('OBSERVER_PARENT_MISSING', {pid:start.pid});
    if (!start.mainThread) problem('WORKER_THREAD_UNQUALIFIED', {pid:start.pid});
    const selfExit = node.events.findLast(e => e.event === 'exit');
    const parentClose = parent?.events.findLast(e => e.event === 'child-close' && e.pid === start.pid);
    const receipt = selfExit ?? parentClose;
    const owner = parent?.parent;
    const ownerSpawn = owner?.start.parent && attempts.get(owner.start.parent.spawnId);
    let owningGroupClosed = owner?.start.pid === rootPid && groupAbsent && stopRequested;
    // Nested runTestFile calls own separate, actually observed detached groups.
    // Reuse the same narrow infrastructure proof for their test workers too.
    if (!owningGroupClosed && process.platform !== 'win32' && owner?.start.testRunner && ownerSpawn?.intent.detached &&
        owner.events.some(e => e.event === 'exit') &&
        ownerSpawn.events.some(e => e.event === 'child-spawn' && e.pid === owner.start.pid)) {
      try { process.kill(-owner.start.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') owningGroupClosed = true; }
    }
    // Node 22's CLI can exit on test abort before it dispatches its worker's
    // close event. Qualify only that direct, non-detached infrastructure worker:
    // observed accepted TERM + AbortError + the owned group actually gone.
    // This cannot qualify an application/detached descendant or pass the test.
    const stoppedTestWorker = !receipt && owningGroupClosed && start.testWorker &&
      owner?.start.testRunner && !parent.intent.detached &&
      parent.events.some(e => e.event === 'child-stop-request' && e.pid === start.pid && e.signal === 'SIGTERM' && e.accepted === true) &&
      parent.events.some(e => e.event === 'child-error' && e.pid === start.pid && e.errorCode === 'ABORT_ERR');
    if (!receipt && !stoppedTestWorker) problem('EXIT_RECEIPT_MISSING', {pid:start.pid, nodeId:start.nodeId, detached:parent?.intent.detached ?? null});
    processes.push({pid:start.pid, nodeId:start.nodeId, parentPid:parent?.parent.start.pid ?? null,
      detached:parent?.intent.detached ?? null, rawExit:receipt ? {code:receipt.code, signal:receipt.signal ?? null} : null,
      proof:selfExit ? 'self-exit-ledger' : parentClose ? 'observed-parent-close' : stoppedTestWorker ? 'aborted-test-worker-group-closed' : null});
  }
  for (const [spawnId, attempt] of attempts) {
    const failed = attempt.events.some(e => (e.event === 'spawn-rejected' && !e.pid) || (e.event === 'child-error' && !e.pid));
    if (failed) continue; // Original spawn failed before creating a process.
    const spawned = attempt.events.find(e => e.event === 'child-spawn');
    const observed = [...nodes.values()].filter(node => node.start.parent?.spawnId === spawnId && node.start.parent?.nodeId === attempt.parent.start.nodeId);
    if (!attempt.intent.inherited) problem('CHILD_OBSERVER_NOT_INHERITED', {pid:spawned?.pid ?? null, parentPid:attempt.parent.start.pid, spawnId});
    if (observed.length !== 1 || (spawned && observed[0]?.start.pid !== spawned.pid)) {
      problem('CHILD_OBSERVER_MISSING', {pid:spawned?.pid ?? null, parentPid:attempt.parent.start.pid, spawnId});
    }
  }
  return {protocol:PROTOCOL, state:unknown.length ? 'UNKNOWN' : 'KNOWN', directory:scope.directory, processes, unknown};
}

module.exports = {OBSERVATION_ENV, PARENT_ENV, PROTOCOL, parseRuns, createObservation, inspectObservation};
