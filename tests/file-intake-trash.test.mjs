// Native-only, owned synthetic regular files. No App, author library, installer or Trash enumeration.
import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';

const native = process.platform === 'darwin', root = path.resolve(import.meta.dirname, '..');
const evidence = path.resolve(process.env.FILE_INTAKE_TRASH_EVIDENCE || path.join(root, '../素材管理器/collab/results/FINDER-VIDEO-INTAKE-20261109/trash-helper/native'));
const checks = [], children = [], trashResults = []; let scene, binary, instrumented, blocked = false;
const hash = data => createHash('sha256').update(data).digest('hex');
const exists = file => fs.lstat(file).then(() => true, e => {if (e.code === 'ENOENT') return false; throw e;});
const stamp = s => ({dev: String(s.dev), ino: String(s.ino), size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(name) {
  const dir = await fs.mkdtemp(path.join(scene, name + '-')), file = path.join(dir, 'sg-native-' + randomUUID() + '.mp4'), data = Buffer.alloc(32 * 1024, 83);
  await fs.writeFile(file, data, {flag: 'wx', mode: 0o600});
  const s = await fs.lstat(file), parent = await fs.lstat(dir);
  return {dir, file, data, stat: s, expected: {identity: stamp(s), parent: {dev: String(parent.dev), ino: String(parent.ino)}, sha256: hash(data)}};
}
function launch(command, args, extra = {}, limit = 15000) {
  assert.equal(blocked, false, 'An earlier owned child exceeded its bound; no further native work');
  const child = spawn(command, args, {cwd: root, env: {...process.env, ...extra}, stdio: ['ignore', 'pipe', 'pipe']});
  let stdout = '', stderr = '', timedOut = false, logLimit = false;
  const record = {command, args, pid: child.pid, actualExit: false, closed: false}; children.push(record);
  const stop = () => {blocked = true; child.kill('SIGTERM');};
  child.stdout.on('data', b => {stdout += b; if (Buffer.byteLength(stdout) > 1024 * 1024 && !logLimit) {logLimit = true; stop();}});
  child.stderr.on('data', b => {stderr += b; if (Buffer.byteLength(stderr) > 1024 * 1024 && !logLimit) {logLimit = true; stop();}});
  child.once('exit', (code, signal) => Object.assign(record, {actualExit: true, code, signal}));
  const timer = setTimeout(() => {timedOut = true; stop();}, limit);
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {clearTimeout(timer); Object.assign(record, {closed: true, code, signal, timedOut, logLimit, stdout, stderr}); resolve(record);});
  });
  return {child, done};
}
function exited(result, code = 0) {
  assert.equal(result.actualExit, true); assert.equal(result.closed, true); assert.equal(result.timedOut, false); assert.equal(result.logLimit, false); assert.equal(result.signal, null); assert.equal(result.code, code, result.stderr);
}
async function expectedFile(file, f, data = f.data) {
  const s = await fs.lstat(file); assert.ok(s.isFile() && !s.isSymbolicLink()); assert.equal(s.dev, f.stat.dev); assert.equal(s.ino, f.stat.ino); assert.equal(hash(await fs.readFile(file)), hash(data));
}
async function restoreOwnTrash(destination, f) {
  // Only the exact path returned for our inode is accessed. Never list or clean the user's Trash.
  await expectedFile(destination, f);
  const restored = path.join(f.dir, 'recovered-' + path.basename(f.file)); await fs.link(destination, restored); await expectedFile(restored, f); await expectedFile(destination, f); await fs.unlink(destination);
  trashResults.push({destination, original: f.file, restored, dev: String(f.stat.dev), ino: String(f.stat.ino), sha256: f.expected.sha256, closed: true});
}
async function noClaims(f) {assert.deepEqual((await fs.readdir(f.dir)).filter(n => n.startsWith('.shiguang-intake-')), []);}
async function barrier(stage, f, change, {throwAfter = false} = {}) {
  const dir = await fs.mkdtemp(path.join(scene, 'barrier-'));
  const running = launch(instrumented, [f.file, JSON.stringify(f.expected)], {SG_TRASH_TEST_STAGE: stage, SG_TRASH_TEST_BARRIER: dir, SG_TRASH_TEST_THROW: throwAfter ? '1' : '0'});
  let ready, failure;
  try {
    for (let i = 0; i < 500; i++) {if (await exists(path.join(dir, 'ready.json'))) {ready = JSON.parse(await fs.readFile(path.join(dir, 'ready.json'), 'utf8')); break;} await pause(10);}
    assert.ok(ready, 'native test copy reaches the exact barrier'); await change(ready, dir);
  } catch (error) {failure = error;} finally {await fs.writeFile(path.join(dir, 'release'), 'release');}
  const result = await running.done; if (failure) throw failure;
  return {result, ready, dir, trashCalls: await exists(path.join(dir, 'trash-call'))};
}
function check(name, fn) {test(name, {skip: !native}, async () => {await fn(); checks.push(name);});}

before(async () => {
  if (!native) return;
  await fs.mkdir(evidence, {recursive: true}); scene = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sg-intake-trash-native-')));
  binary = path.join(scene, 'trash-product'); instrumented = path.join(scene, 'trash-barrier');
  const source = await fs.readFile(path.join(root, 'server/trash.swift'), 'utf8');
  const prelude = `
func testCheckpoint(_ stage: String, _ file: String) throws {
    let env = ProcessInfo.processInfo.environment
    guard env["SG_TRASH_TEST_STAGE"] == stage, let dir = env["SG_TRASH_TEST_BARRIER"] else {return}
    let data = try JSONSerialization.data(withJSONObject:["stage":stage,"path":file])
    try data.write(to:URL(fileURLWithPath:dir+"/ready.json"),options:.atomic)
    let deadline = Date().addingTimeInterval(8)
    while !FileManager.default.fileExists(atPath:dir+"/release") {
        guard Date() < deadline else {throw failBound("synthetic barrier deadline")}
        usleep(1000)
    }
    if env["SG_TRASH_TEST_THROW"] == "1" {throw failBound("synthetic Trash refusal")}
}
func testTrashRecord(_ file: String) throws {
    if let dir = ProcessInfo.processInfo.environment["SG_TRASH_TEST_BARRIER"] {try Data(file.utf8).write(to:URL(fileURLWithPath:dir+"/trash-call"))}
}
`;
  let copy = prelude + source;
  function inject(needle, text) {assert.equal(copy.split(needle).length, 2, 'exact test-copy anchor: ' + needle); copy = copy.replace(needle, text + needle);}
  inject('        guard renameatx_np(parentFD,name,claimFD,name,UInt32(RENAME_EXCL))', '        try testCheckpoint("before-claim",file)\n');
  inject('        let held = try current(originalFD)', '        try testCheckpoint("after-claim",claimPath())\n');
  inject('        let after = try current(originalFD), pathStat', '        try testCheckpoint("after-hash",claimPath())\n');
  inject('        var resulting: NSURL?', '        try testCheckpoint("before-trash",claimPath())\n        try testTrashRecord(claimPath())\n');
  inject('        trashSucceeded = true', `        if let dir = ProcessInfo.processInfo.environment["SG_TRASH_TEST_BARRIER"], let actual = resulting?.path {
            try Data(actual.utf8).write(to:URL(fileURLWithPath:dir+"/actual-destination"))
        }
        if ProcessInfo.processInfo.environment["SG_TRASH_TEST_NIL_RESULT"] == "1" {resulting = nil}
`);
  await fs.writeFile(path.join(scene, 'trash-barrier.swift'), copy); await fs.writeFile(path.join(scene, 'trash-product.swift'), source);
  for (const [input, output] of [[path.join(root, 'server/trash.swift'), binary], [path.join(scene, 'trash-barrier.swift'), instrumented]]) {
    const result = await launch('swiftc', ['-module-cache-path', path.join(scene, 'module-cache'), input, '-o', output], {}, 60000).done; exited(result);
  }
  await fs.writeFile(path.join(evidence, 'scene.json'), JSON.stringify({scene, sourceSha256: hash(Buffer.from(source)), productBinary: binary, barrierBinary: instrumented}, null, 2) + '\n');
});

check('bound production helper sends only verified inode to real Trash and preserves basename/extension', async () => {
  const f = await fixture('success'), result = await launch(binary, [f.file, JSON.stringify(f.expected)]).done; exited(result);
  const destination = JSON.parse(result.stdout); assert.equal(path.basename(destination), path.basename(f.file)); assert.equal(await exists(f.file), false);
  try {await expectedFile(destination, f); await noClaims(f);} finally {await restoreOwnTrash(destination, f);}
});
check('new inode with identical bytes is refused before claim; original and replacement remain', async () => {
  const f = await fixture('replacement'), retained = f.file + '.retained'; await fs.rename(f.file, retained); await fs.writeFile(f.file, f.data, {flag: 'wx'});
  const replacement = await fs.lstat(f.file), result = await launch(binary, [f.file, JSON.stringify(f.expected)]).done; exited(result, 1);
  assert.equal((await fs.lstat(f.file)).ino, replacement.ino); await expectedFile(retained, f); await noClaims(f);
});
check('wrong parent and mismatched approved hash are refused; hash failure restores without overwrite', async () => {
  for (const kind of ['parent', 'hash']) {
    const f = await fixture(kind), input = structuredClone(f.expected); if (kind === 'parent') input.parent.ino = String(BigInt(input.parent.ino) + 1n); else input.sha256 = '0'.repeat(64);
    const result = await launch(binary, [f.file, JSON.stringify(input)]).done; exited(result, 1); await expectedFile(f.file, f); await noClaims(f);
    if (kind === 'hash') assert.match(result.stderr, /已恢复到/);
  }
});
check('P1 replacement after the last source check is claimed then restored, never sent to Trash', async () => {
  const f = await fixture('last-gate-race'), retained = f.file + '.retained', replacementData = Buffer.alloc(f.data.length, 82); let replacement;
  const {result, trashCalls} = await barrier('before-claim', f, async () => {await fs.rename(f.file, retained); await fs.writeFile(f.file, replacementData, {flag: 'wx'}); replacement = await fs.lstat(f.file);});
  exited(result, 1); assert.equal(trashCalls, false); assert.equal((await fs.lstat(f.file)).ino, replacement.ino); assert.deepEqual(await fs.readFile(f.file), replacementData); await expectedFile(retained, f); await noClaims(f);
});
check('stable-hash gate rejects same-inode mutation after hashing and restores the held file', async () => {
  const f = await fixture('hash-race'), changed = Buffer.alloc(f.data.length, 77);
  const {result, trashCalls} = await barrier('after-hash', f, async ready => {await fs.writeFile(ready.path, changed);});
  exited(result, 1); assert.equal(trashCalls, false); await expectedFile(f.file, f, changed); await noClaims(f);
});
check('rollback cannot overwrite new source; original remains in random 0700 claim with basename reported', async () => {
  const f = await fixture('rollback-race'), replacementData = Buffer.alloc(f.data.length, 78); let retained;
  const {result, trashCalls} = await barrier('after-claim', f, async ready => {retained = ready.path; assert.equal(path.basename(retained), path.basename(f.file)); assert.equal((await fs.lstat(path.dirname(retained))).mode & 0o777, 0o700); await fs.writeFile(f.file, replacementData, {flag: 'wx'});}, {throwAfter: true});
  exited(result, 1); assert.equal(trashCalls, false); assert.match(result.stderr, /文件保留在/); assert.ok(result.stderr.includes(retained)); await expectedFile(retained, f); assert.deepEqual(await fs.readFile(f.file), replacementData);
});
check('new source after private claim stays intact while only the held original enters real Trash', async () => {
  const f = await fixture('private-path'), replacementData = Buffer.alloc(f.data.length, 84);
  const {result, ready, trashCalls} = await barrier('before-trash', f, async ready => {assert.equal(path.basename(ready.path), path.basename(f.file)); await fs.writeFile(f.file, replacementData, {flag: 'wx'});});
  exited(result); assert.equal(trashCalls, true); assert.ok(ready.path.includes('/.shiguang-intake-')); const destination = JSON.parse(result.stdout);
  try {assert.deepEqual(await fs.readFile(f.file), replacementData); await expectedFile(destination, f); await noClaims(f);} finally {await restoreOwnTrash(destination, f);}
});
check('real Trash success without resultingURL is UNKNOWN and never falsely reports recovery', async () => {
  const f = await fixture('nil-result'), dir = await fs.mkdtemp(path.join(scene, 'nil-result-record-'));
  const result = await launch(instrumented, [f.file, JSON.stringify(f.expected)], {SG_TRASH_TEST_BARRIER: dir, SG_TRASH_TEST_NIL_RESULT: '1'}).done; exited(result, 1);
  const destination = await fs.readFile(path.join(dir, 'actual-destination'), 'utf8');
  try {assert.match(result.stderr, /UNKNOWN/); assert.match(result.stderr, /未执行恢复/); assert.doesNotMatch(result.stderr, /已恢复到|未送入废纸篓/); assert.equal(await exists(f.file), false); await expectedFile(destination, f);} finally {await restoreOwnTrash(destination, f);}
});
check('one-argument production protocol remains compatible, including empty file and JSON destination', async () => {
  const f = await fixture('one-arg'); await fs.writeFile(f.file, ''); f.data = Buffer.alloc(0); f.expected.sha256 = hash(f.data);
  const result = await launch(binary, [f.file]).done; exited(result); const destination = JSON.parse(result.stdout);
  try {assert.equal(await exists(f.file), false); await expectedFile(destination, f);} finally {await restoreOwnTrash(destination, f);}
});

after(async () => {
  if (!native) return;
  const resourcesClosed = children.every(c => c.actualExit && c.closed && !c.signal && !c.timedOut && !c.logLimit);
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify({passed: checks.length === 9 && resourcesClosed, checks, resourcesClosed, children, trashResults, scene, scope: 'Product native binary plus exact-source barrier copy with real FileManager Trash; owned synthetic files only; all returned owned Trash entries restored into own scene. No App/services/library/native installation/Git mutation.'}, null, 2) + '\n');
  assert.ok(resourcesClosed, 'Every compiler/helper witnessed actual exit and close; no force kill');
});
