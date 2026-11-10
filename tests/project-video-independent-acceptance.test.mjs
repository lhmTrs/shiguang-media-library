import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {Library} from '../server/library.mjs';
import {Projects} from '../server/projects.mjs';
import {ProjectAssets} from '../server/project-assets/store.mjs';
import {StoryboardDatabase} from '../server/storyboard/database.mjs';
import {emptyProject, emptyShot} from '../server/storyboard/shared/model.mjs';
import {createStoryboardVideo} from '../server/storyboard-video/index.mjs';
import {VideoMedia} from '../server/storyboard-video/media.mjs';
import {ProjectVideos} from '../server/project-videos/store.mjs';
import {ProjectVideoDesktopNative} from '../server/project-videos/desktop-native.mjs';
import {mediaContentFingerprint} from '../server/project-videos/content-identity.mjs';
import {canonical, digest} from '../server/project-assets/model.mjs';

// Independent fixtures: no author test/helper imports, no production service,
// clipboard, Finder, MySQL or existing user data. Assertions state the contract.
const evidence = process.env.INDEPENDENT_VIDEO_EVIDENCE;
// Overrides take one executable path/name, never shell arguments. Otherwise use
// existing PATH tools; no installation or additional dependency is attempted.
const commands = {
  ffmpeg: process.env.INDEPENDENT_VIDEO_FFMPEG || 'ffmpeg',
  ffprobe: process.env.INDEPENDENT_VIDEO_FFPROBE || process.env.MEDIA_STORYBOARD_FFPROBE || 'ffprobe',
  ps: process.env.INDEPENDENT_VIDEO_PS || 'ps',
};
const toolChecks = new Map();
function unavailableTool(name, args = ['-version']) {
  if (!toolChecks.has(name)) {
    const checked = spawnSync(commands[name], args, {stdio: 'ignore', timeout: 5000, killSignal: 'SIGKILL'});
    const failure = checked.error?.code || (checked.status !== 0 ? `exit ${checked.status}, signal ${checked.signal}` : null);
    toolChecks.set(name, failure ? `${name} unavailable (${failure}); use PATH or INDEPENDENT_VIDEO_${name.toUpperCase()}` : null);
  }
  return toolChecks.get(name);
}
function mediaTest(name, run, {requiresIdentity = true} = {}) {
  test(name, async t => {
    if (requiresIdentity && process.platform === 'win32') return t.skip('media content identity requires POSIX descriptors; Windows is unsupported');
    const missing = [unavailableTool('ffmpeg'), unavailableTool('ffprobe')].filter(Boolean);
    if (missing.length) return t.skip(missing.join('; '));
    return run(t);
  });
}
const sha = b => createHash('sha256').update(b).digest('hex');
const tracked = ['server/index.mjs', 'server/project-videos/store.mjs', 'server/project-videos/router.mjs',
  'server/project-videos/content-identity.mjs', 'server/project-videos/verification.mjs',
  'server/project-videos/desktop-native.mjs', 'server/project-videos/desktop-native.swift',
  'server/project-videos/desktop-actions.mjs', 'server/project-videos/action-journal.mjs',
  'server/project-videos/content-changes.mjs', 'server/storyboard-video/store.mjs'];
async function note(name, data) {
  if (evidence) { await fs.mkdir(evidence, {recursive: true}); await fs.writeFile(path.join(evidence, name + '.json'), JSON.stringify(data, null, 2)); }
}
await note('source-at-start', Object.fromEntries(await Promise.all(tracked.map(async p => [p, sha(await fs.readFile(new URL('../' + p, import.meta.url)))]))));
test.after(async () => {
  await note('source-at-end', Object.fromEntries(await Promise.all(tracked.map(async p => [p, sha(await fs.readFile(new URL('../' + p, import.meta.url)))]))));
});

let mediaBytes;
async function bytes() {
  if (mediaBytes) return mediaBytes;
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sg-independent-media-')));
  try {
    const file = path.join(dir, 'fixture.mp4');
    const r = spawnSync(commands.ffmpeg, ['-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=c=navy:s=80x64:r=10:d=4',
      '-f', 'lavfi', '-i', 'sine=frequency=523:sample_rate=48000:duration=4',
      '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-metadata', 'title=INDEPENDENT-BASE', '-shortest', file], {timeout: 10000});
    assert.equal(r.status, 0, r.stderr?.toString());
    mediaBytes = await fs.readFile(file); return mediaBytes;
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
}
function nativeStub() {
  return {calls: [], version: 31,
    async capabilities() { return {clipboard: {available: true}, revealMany: {available: true}}; },
    async clipboardVersion() { return this.version; },
    async copyFiles(files, options) { this.calls.push({kind: 'copy', files, options}); return {ack: 'written', count: files.length}; },
    async revealFiles(files) { this.calls.push({kind: 'reveal', files}); return {ack: 'dispatched', count: files.length}; },
    async close() {},
  };
}
async function fixture(t, {trash} = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sg-independent-catalog-')));
  const lib = await new Library(path.join(dir, 'db')).init();
  lib.enqueue = () => {};
  const projects = new Projects(lib).init(), assets = new ProjectAssets(lib).init();
  const storyboards = new StoryboardDatabase(lib, assets).init();
  const entry = createStoryboardVideo({lib, storyboards, command: commands.ffprobe});
  const native = nativeStub(), catalog = new ProjectVideos(entry.store, {directory: path.join(dir, 'files', 'video'), desktopNative: native, trash});
  const a = projects.save(null, {name: 'Independent A'}), b = projects.save(null, {name: 'Independent B'});
  t.after(async () => {
    await catalog.close(); await entry.close();
    assert.equal(entry.media.children.size, 0); assert.equal(entry.media.handles.size, 0);
    assert.equal(entry.media.work.size, 0); assert.equal(entry.media.closes.size, 0);
    lib.db.close(); await fs.rm(dir, {recursive: true, force: true});
  });
  return {dir, lib, projects, assets, storyboards, entry, native, c: catalog, v: entry.store, a, b};
}
async function source(f, {legacy = false, baseline = true, projectId = f.a.id, content} = {}) {
  const root = legacy ? null : await f.c.prepareRoot(projectId);
  const folder = legacy ? path.join(f.dir, 'external') : root.target;
  await fs.mkdir(folder, {recursive: true});
  const file = path.join(folder, randomUUID() + '.mp4');
  await fs.writeFile(file, content || await bytes());
  const probe = await f.entry.media.probe(file), id = randomUUID(), now = Date.now();
  f.lib.db.prepare('INSERT INTO storyboard_video_sources VALUES(?,?,?,?,?)').run(id, projectId, canonical(probe), now, now);
  let value = {id, project_id: projectId, ...probe}; f.v.approve(value);
  if (!legacy) {
    const d = await f.c.hash(file), mediaId = f.c.index(root.root, file, d);
    const fp = baseline ? await mediaContentFingerprint(f.entry.media, value) : null;
    const data = {title: 'Independent video', notes: 'Keep this note', promptId: null,
      managed: true, sha256: d.hash, removedAt: 0, mediaAssetId: mediaId,
      ...(fp ? {contentFingerprint: {version: fp.version, hash: fp.hash}} : {})};
    f.c.record(projectId, id, data, 1); f.c.approveManaged(value);
  }
  return value;
}
async function result(f, start) {
  const first = start(); await f.c.actionJournal.tail;
  return f.c.actionJournal.dto(f.c.actionJournal.row(first.projectId, first.requestId));
}
function initShots(f, durations = [1000, 1000, 1000]) {
  const p = emptyProject(); p.title = 'Independent timeline';
  p.scenes[0].shots = durations.map(duration_ms => ({...emptyShot(), duration_ms}));
  f.storyboards.initialize(f.a.id, {source: p, request_id: randomUUID(), expected_revision: null});
  return f.v.current(f.a.id);
}
function takes(f, s, intervals) {
  const state = f.v.current(f.a.id), adopted = {};
  for (const [i, interval] of intervals.entries()) adopted[state.shots[i].id] = f.v.addTake(f.a.id, state, state.shots[i].id,
    interval.map(([inMs, outMs, sourceId = s.id]) => ({sourceId, inMs, outMs})), 'manual');
  f.v.savePlan(f.a.id, state, adopted); return {state, adopted};
}
function boxes(b, start = 0, end = b.length, trail = '') {
  const found = [];
  for (let at = start; at < end;) {
    const length = b.readUInt32BE(at), type = b.toString('latin1', at + 4, at + 8);
    assert.ok(length >= 8 && at + length <= end, 'independent fixture has ordinary MP4 boxes');
    const entry = {type, start: at, body: at + 8, end: at + length, trail: trail + '/' + type}; found.push(entry);
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'meta', 'ilst'].includes(type))
      found.push(...boxes(b, entry.body + (type === 'meta' ? 4 : 0), entry.end, entry.trail));
    at += length;
  }
  return found;
}
function variant(input, kind) {
  const b = Buffer.from(input), all = boxes(b);
  if (kind === 'title') {
    const at = b.indexOf('INDEPENDENT-BASE'); assert.ok(at > 0); b.write('INDEPENDENT-NEXT', at, 'ascii');
  } else if (kind === 'clock') {
    const box = all.find(x => x.type === 'mvhd'); assert.equal(b[box.body], 0); b.writeUInt32BE(b.readUInt32BE(box.body + 16) * 2, box.body + 16);
  } else if (kind === 'rotation') {
    const box = all.find(x => x.type === 'tkhd'); assert.equal(b[box.body], 0);
    [0, -65536, 0, 65536, 0, 0, 0, 0, 1073741824].forEach((v, i) => b.writeInt32BE(v, box.body + 40 + i * 4));
  } else if (kind === 'audio-volume') {
    const box = all.filter(x => x.type === 'tkhd').at(1); assert.equal(b[box.body], 0);
    assert.notEqual(b.readUInt16BE(box.body + 36), 0); b.writeUInt16BE(0, box.body + 36);
  } else throw Error('unknown fixture variant');
  return b;
}
async function rewrite(file, content) { const h = await fs.open(file, 'r+'); try { await h.truncate(0); await h.writeFile(content); await h.sync(); } finally { await h.close(); } }

test('N1 native timeout settles the owned process group, including a TERM-resistant descendant', async t => {
  if (process.platform === 'win32') return t.skip('N1 requires actual POSIX process groups, signals and ps');
  const missing = unavailableTool('ps', ['-p', String(process.pid), '-o', 'stat=']);
  if (missing) return t.skip(missing);
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sg-independent-native-')));
  const pidFile = path.join(dir, 'descendant.pid'), parentFile = path.join(dir, 'parent.cjs');
  const childCode = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
  await fs.writeFile(parentFile, `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});setInterval(()=>{},1000);`);
  const n = new ProjectVideoDesktopNative({directory: dir}); let descendant, group, runError, closeError;
  try {
    const work = n.run(process.execPath, [parentFile], '', 800); work.catch(() => {});
    group = [...n.children.keys()][0].pid;
    for (let i = 0; i < 60; i++) { try { descendant = Number(await fs.readFile(pidFile, 'utf8')); break; } catch { await delay(10); } }
    assert.ok(descendant > 0, 'descendant ready before timeout');
    try { await work; } catch (e) { runError = e.code; }
    await delay(350);
    try { await n.close(); } catch (e) { closeError = e.code; }
    let alive = false; try { process.kill(descendant, 0); alive = true; } catch {}
    await note('N1-native-descendant', {runError, closeError, tracked: n.children.size, descendantAliveAfterClose: alive});
    assert.equal(alive, false, 'native.close resolved with an actual owned descendant still alive');
  } finally {
    if (group) try { process.kill(-group, 'SIGKILL'); } catch {}
    if (descendant) try { process.kill(descendant, 'SIGKILL'); } catch {}
    let stillRunning = false;
    if (descendant) for (let i = 0; i < 100; i++) {
      const state = spawnSync(commands.ps, ['-p', String(descendant), '-o', 'stat='], {encoding: 'utf8'}).stdout.trim();
      stillRunning = !!state && !state.startsWith('Z');
      if (!stillRunning) break;
      await delay(10);
    }
    await note('N1-cleanup', {ownGroupSignaled: !!group, ownDescendantKnownNotRunning: !stillRunning});
    assert.equal(stillRunning, false, 'independent fixture must leave no live descendant');
    await n.close().catch(() => {}); await fs.rm(dir, {recursive: true, force: true});
  }
});

mediaTest('A1 current-authorized external legacy video remains eligible without copying/upgrading', async t => {
  const f = await fixture(t), s = await source(f, {legacy: true});
  const outcome = await result(f, () => f.c.desktop.clipboard(f.a.id, {requestId: randomUUID(), ids: [s.id]}));
  await note('A1-legacy', outcome);
  assert.equal(outcome.status, 'completed'); assert.equal(outcome.copied[0].managed, false);
  assert.deepEqual(f.native.calls[0].files, [s.path]);
}, {requiresIdentity: false});

mediaTest('C1 same compressed bytes cannot hide movie clock, rotation or audio volume changes', async t => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sg-independent-identity-'))), media = new VideoMedia({command: commands.ffprobe});
  try {
    const summaries = {}, original = await bytes();
    for (const kind of ['base', 'title', 'clock', 'rotation', 'audio-volume']) {
      const file = path.join(dir, kind + '.mp4'); await fs.writeFile(file, kind === 'base' ? original : variant(original, kind));
      const fp = await mediaContentFingerprint(media, {path: file}); summaries[kind] = {hash: fp.hash, fileHash: fp.fileHash};
    }
    await note('C1-identity', summaries);
    assert.notEqual(summaries.base.fileHash, summaries.title.fileHash); assert.equal(summaries.base.hash, summaries.title.hash);
    for (const kind of ['clock', 'rotation', 'audio-volume']) assert.notEqual(summaries.base.hash, summaries[kind].hash, kind);
  } finally { await media.close(); assert.equal(media.handles.size, 0); await fs.rm(dir, {recursive: true, force: true}); }
});

mediaTest('C2 old no-fingerprint record refuses changed bytes and preserves its old hash/approval', async t => {
  const f = await fixture(t), s = await source(f, {baseline: false}), old = f.c.metadata(f.a.id, s);
  await rewrite(s.path, variant(await bytes(), 'title'));
  await assert.rejects(f.c.verifiedSource(f.a.id, s.id), e => e.code === 'SOURCE_CHANGED');
  assert.deepEqual(f.c.metadata(f.a.id, s), old); assert.equal(f.v.authorized(s), true);
}, {requiresIdentity: false});

mediaTest('C3 metadata-only verification updates one ID atomically, preserving notes and current adoption', async t => {
  const f = await fixture(t); initShots(f); const s = await source(f); const {adopted} = takes(f, s, [[[100, 900]]]);
  const old = f.c.metadata(f.a.id, s); await rewrite(s.path, variant(await bytes(), 'title'));
  const updated = await f.c.verifiedSource(f.a.id, s.id), after = f.c.metadata(f.a.id, updated);
  assert.equal(updated.id, s.id); assert.notEqual(after.data.sha256, old.data.sha256); assert.equal(after.data.notes, old.data.notes);
  assert.equal(f.c.isManaged(f.a.id, updated), true); assert.equal(f.v.authorized(updated), true);
  assert.deepEqual(f.c.adoption(f.a.id).current.plan.adopted, adopted);
  assert.deepEqual(f.c.verification.view(updated), {state: 'verified', match: 'media', metadataChanged: true});
});

mediaTest('A2 50-selection partial skips, no response retry, unknown ACK and clipboard change guards', async t => {
  const f = await fixture(t), a = await source(f), b = await source(f), ids = [a.id, b.id, ...Array.from({length: 48}, () => randomUUID())];
  const requestId = randomUUID(), input = {requestId, ids};
  const first = await result(f, () => f.c.desktop.clipboard(f.a.id, input));
  assert.equal(first.status, 'partial'); assert.equal(first.count, 2); assert.equal(first.skipped.length, 48);
  assert.deepEqual(f.native.calls[0].files, [a.path, b.path]);
  assert.deepEqual(f.c.desktop.clipboard(f.a.id, input), first); assert.equal(f.native.calls.length, 1);
  assert.throws(() => f.c.desktop.clipboard(f.a.id, {...input, ids: [b.id, a.id]}), e => e.code === 'REQUEST_ID_CONFLICT');
  f.native.copyFiles = async () => { f.native.calls.push({kind: 'lost-ack'}); throw Object.assign(Error('lost'), {code: 'NATIVE_PROTOCOL_ERROR', status: 503, effectUnknown: true}); };
  const lostInput = {requestId: randomUUID(), ids: [a.id]}, lost = await result(f, () => f.c.desktop.clipboard(f.a.id, lostInput));
  assert.equal(lost.status, 'unknown'); assert.deepEqual(f.c.desktop.clipboard(f.a.id, lostInput), lost); assert.equal(f.native.calls.length, 2);
  f.native.copyFiles = async (_files, {expectedChangeCount}) => { assert.equal(expectedChangeCount, 31); throw Object.assign(Error('changed'), {code: 'CLIPBOARD_CHANGED', status: 409, effectUnknown: false}); };
  const changed = await result(f, () => f.c.desktop.clipboard(f.a.id, {requestId: randomUUID(), ids: [a.id]}));
  assert.equal(changed.status, 'failed'); assert.equal(changed.code, 'CLIPBOARD_CHANGED');
});

mediaTest('B1 preview token rejects another project, changed record, expiry and replaced root', async t => {
  const f = await fixture(t), s = await source(f), id = f.a.id;
  const preview = async () => result(f, () => f.c.desktop.revealPreview(id, {requestId: randomUUID(), ids: [s.id]}));
  const execute = async (p, projectId = id) => result(f, () => f.c.desktop.reveal(projectId, {requestId: randomUUID(), ids: [s.id], previewToken: p.previewToken}));
  let p = await preview(); assert.equal((await execute(p, f.b.id)).status, 'failed');
  const m = f.c.metadata(id, s); f.c.record(id, s.id, {...m.data, title: 'Changed after preview'}, 2); f.c.approveManaged(s);
  assert.equal((await execute(p)).code, 'PREVIEW_STALE');
  p = await preview(); const row = f.c.actionJournal.row(id, p.requestId); row.preview.expiresAt = Date.now() - 1; f.c.actionJournal.save(row);
  assert.equal((await execute(p)).code, 'PREVIEW_STALE');
  p = await preview(); const oldRoot = path.dirname(s.path), retained = oldRoot + '-retained';
  await fs.rename(oldRoot, retained); await fs.mkdir(oldRoot); await fs.link(path.join(retained, path.basename(s.path)), s.path);
  const rootResult = await execute(p); await note('B1-replaced-root', rootResult);
  assert.equal(rootResult.status, 'failed', 'same inode/file at a newly created root must invalidate preview');
  assert.equal(f.native.calls.length, 0);
});

mediaTest('D1 frozen candidate A cannot accept current B; ordinary media remains guarded', async t => {
  const f = await fixture(t), s = await source(f); await rewrite(s.path, variant(await bytes(), 'rotation'));
  const p = await result(f, () => f.c.changes.preview(f.a.id, s.id, {requestId: randomUUID(), expectedRevision: 1}));
  assert.equal(p.status, 'ready'); const opened = await f.c.changes.open(f.a.id, s.id, p.contentToken);
  const candidate = await opened.handle.readFile(); await f.entry.media.release(opened.handle);
  assert.deepEqual(candidate, variant(await bytes(), 'rotation'));
  await assert.rejects(f.c.open(f.a.id, s.id), e => e.code === 'SOURCE_CHANGED');
  await rewrite(s.path, variant(await bytes(), 'audio-volume'));
  const accept = await result(f, () => f.c.changes.accept(f.a.id, s.id, {requestId: randomUUID(), expectedRevision: 1, adoptionStamp: p.adoptionStamp,
    contentToken: p.contentToken, confirmAcceptContent: true, confirmedUnbindShotIds: []}));
  assert.equal(accept.status, 'failed'); assert.equal(f.c.metadata(f.a.id, s).row.revision, 1);
  const frozen = await f.c.changes.open(f.a.id, s.id, p.contentToken); assert.deepEqual(await frozen.handle.readFile(), candidate); await f.entry.media.release(frozen.handle);
});

mediaTest('D2 shorter current content keeps original source ID and only unbinds exact invalid mixed take', async t => {
  const f = await fixture(t); initShots(f); const s = await source(f), other = await source(f);
  const {state, adopted} = takes(f, s, [[[0, 800]], [[0, 300, other.id], [3000, 3600]], [[800, 1600]]]);
  const file = path.join(f.dir, 'short.mp4'); const r = spawnSync(commands.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', s.path, '-t', '2', '-c', 'copy', file], {timeout: 10000});
  assert.equal(r.status, 0); await rewrite(s.path, await fs.readFile(file));
  const p = await result(f, () => f.c.changes.preview(f.a.id, s.id, {requestId: randomUUID(), expectedRevision: 1}));
  assert.equal(p.status, 'ready'); assert.deepEqual(p.invalidAdoptedShots.map(x => x.id), [state.shots[1].id]);
  const input = {requestId: randomUUID(), expectedRevision: 1, contentToken: p.contentToken, adoptionStamp: p.adoptionStamp, confirmAcceptContent: true, confirmedUnbindShotIds: []};
  assert.equal((await result(f, () => f.c.changes.accept(f.a.id, s.id, input))).code, 'UNBIND_CONFIRMATION_REQUIRED');
  const accepted = await result(f, () => f.c.changes.accept(f.a.id, s.id, {...input, requestId: randomUUID(), confirmedUnbindShotIds: [state.shots[1].id]}));
  assert.equal(accepted.status, 'completed'); assert.equal(accepted.sourceId, s.id);
  assert.deepEqual(f.v.baseState(f.a.id).plan.adopted, {[state.shots[0].id]: adopted[state.shots[0].id], [state.shots[2].id]: adopted[state.shots[2].id]});
  assert.equal(f.v.baseState(f.a.id).shots.length, 3); assert.equal(f.c.metadata(f.a.id, s).data.notes, 'Keep this note');
  const backup = f.storyboards.backup(); assert.doesNotThrow(() => f.storyboards.validateBackup(backup), 'real formerly valid historical take remains backup-compatible');
  const originalHistorical = structuredClone(backup), video = backup.video_preview;
  const invalid = video.storyboard_video_takes.find(row => row.id === adopted[state.shots[1].id]);
  const data = JSON.parse(invalid.data_json); data.segments.find(x => x.sourceId === s.id).outMs = 3600000; invalid.data_json = canonical(data);
  invalid.created_at = Date.now() + 1000; invalid.updated_at = invalid.created_at;
  backup.checksum = digest({tables: backup.tables, creative: backup.creative, video_preview: video});
  let rejected = false; try { f.storyboards.validateBackup(backup); } catch { rejected = true; }
  await note('D2-backup-overbroad-history', {accepted, originalHistoricalValidated: true, forgedOneHourTakeCreatedAfterAcceptanceRejected: rejected,
    currentSourceDurationMs: f.v.source(f.a.id, s.id).durationMs});
  assert.equal(rejected, true, 'contentAcceptance must not legalize arbitrary later one-hour segments');
  assert.ok(originalHistorical.video_preview.storyboard_video_takes.length);
});

mediaTest('D3 database removal remains partial after trash failure and identical request never re-trashes', async t => {
  let trashCalls = 0;
  const f = await fixture(t, {trash: async () => { trashCalls++; throw Object.assign(Error('own synthetic failure'), {code: 'EACCES'}); }});
  initShots(f); const s = await source(f); takes(f, s, [[[0, 900]]]);
  const p = await result(f, () => f.c.changes.removePreview(f.a.id, s.id, {requestId: randomUUID(), expectedRevision: 1}));
  assert.equal(p.canTrash, true);
  const input = {requestId: randomUUID(), expectedRevision: 1, removalToken: p.removalToken, adoptionStamp: p.adoptionStamp, confirmUnbind: true, fileAction: 'trash'};
  const removed = await result(f, () => f.c.changes.remove(f.a.id, s.id, input));
  assert.equal(removed.status, 'partial'); assert.equal(removed.record.removed, true); assert.equal(removed.file.status, 'failed');
  assert.deepEqual(f.v.baseState(f.a.id).plan.adopted, {}); await fs.access(s.path);
  assert.deepEqual(f.c.changes.remove(f.a.id, s.id, input), removed); assert.equal(trashCalls, 1);
});

mediaTest('D4 keep-removal works with missing file; preview cannot borrow cross-project token', async t => {
  const f = await fixture(t), s = await source(f); await fs.unlink(s.path);
  const p = await result(f, () => f.c.changes.removePreview(f.a.id, s.id, {requestId: randomUUID(), expectedRevision: 1}));
  assert.equal(p.status, 'ready'); assert.equal(p.canTrash, false);
  assert.throws(() => f.c.changes.find(f.b.id, s.id, p.removalToken, 'remove-preview'), e => e.code === 'PREVIEW_STALE');
  const r = await result(f, () => f.c.changes.remove(f.a.id, s.id, {requestId: randomUUID(), expectedRevision: 1, removalToken: p.removalToken,
    adoptionStamp: p.adoptionStamp, confirmUnbind: true, fileAction: 'keep'}));
  assert.equal(r.status, 'completed'); assert.equal(r.file.status, 'kept'); assert.equal(r.record.removed, true);
});

mediaTest('B2 replacing the registered storage root cannot reuse a preview even with identical project/file inodes', async t => {
  const f = await fixture(t), s = await source(f), id = f.a.id;
  const p = await result(f, () => f.c.desktop.revealPreview(id, {requestId: randomUUID(), ids: [s.id]}));
  const storage = f.c.directory, moved = storage + '-retained', projectName = path.basename(path.dirname(s.path));
  const before = await fs.stat(s.path), rootBefore = await fs.stat(storage);
  await fs.rename(storage, moved); await fs.mkdir(storage);
  await fs.rename(path.join(moved, projectName), path.join(storage, projectName));
  const after = await fs.stat(s.path), rootAfter = await fs.stat(storage);
  assert.equal(before.ino, after.ino); assert.equal(before.ctimeMs, after.ctimeMs); assert.notEqual(rootBefore.ino, rootAfter.ino);
  const executed = await result(f, () => f.c.desktop.reveal(id, {requestId: randomUUID(), ids: [s.id], previewToken: p.previewToken}));
  await note('B2-storage-root', {sameFileInodeAndCtime: true, storageRootReplaced: true, executed, nativeCalls: f.native.calls.length});
  assert.equal(executed.status, 'failed'); assert.equal(f.native.calls.length, 0);
});

mediaTest('C4 whole-file-equal recheck can establish a missing historical content baseline', async t => {
  const f = await fixture(t), s = await source(f, {baseline: false});
  const old = f.c.metadata(f.a.id, s), stat = await fs.stat(s.path);
  await fs.utimes(s.path, stat.atime, new Date(stat.mtimeMs + 2000));
  const current = await f.c.verifiedSource(f.a.id, s.id), meta = f.c.metadata(f.a.id, current);
  await note('C4-equal-file-backfill', {fileHashPreserved: old.data.sha256 === meta.data.sha256, baseline: meta.data.contentFingerprint ?? null,
    managed: f.c.isManaged(f.a.id, current), state: f.c.verification.view(current)});
  assert.equal(meta.data.sha256, old.data.sha256); assert.equal(meta.data.contentFingerprint?.version, 'sg-media-content-v1');
});

mediaTest('D5 existing old fingerprint cannot prove content_changed when current comparator is unavailable', async t => {
  const f = await fixture(t), s = await source(f); await rewrite(s.path, variant(await bytes(), 'title'));
  const wrapper = path.join(f.dir, 'probe-only.cjs');
  await fs.writeFile(wrapper, '#!' + process.execPath + '\n' +
    `const {spawnSync}=require('node:child_process');const a=process.argv.slice(2);if(!a.includes('-show_entries'))process.exit(2);const r=spawnSync(${JSON.stringify(commands.ffprobe)},a,{stdio:['ignore','inherit','inherit',3]});process.exit(r.status??3);\n`, {mode: 0o700});
  f.entry.media.command = wrapper;
  const p = await result(f, () => f.c.changes.preview(f.a.id, s.id, {requestId: randomUUID(), expectedRevision: 1}));
  await note('D5-not-comparable', p);
  assert.equal(p.status, 'ready'); assert.equal(p.changeKind, 'not_comparable', 'a stored baseline alone does not prove current bytes changed media content');
});
