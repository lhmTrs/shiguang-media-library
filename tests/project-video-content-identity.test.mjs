import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { VideoMedia } from '../server/storyboard-video/media.mjs';
import { mediaContentFingerprint, mediaContentFingerprintCapability } from '../server/project-videos/content-identity.mjs';

const exec = promisify(execFile);
const available = process.platform !== 'win32' && ['ffmpeg', 'ffprobe'].every(c => spawnSync(c, ['-version'], { stdio: 'ignore', shell: false }).status === 0);
const options = { skip: !available };
let root, base, baseline, flat;
const active = new Set();
const media = opts => { const m = new VideoMedia(opts); active.add(m); return m; };
const fingerprint = (file, m = media()) => mediaContentFingerprint(m, { path: file });
const ffmpeg = args => exec('ffmpeg', ['-v', 'error', '-nostdin', ...args], { maxBuffer: 1048576, cwd: root, env: { ...process.env, FFREPORT: undefined } });
const variant = async (name, args) => { const file = path.join(root, name); await ffmpeg([...args, '-y', file]); return file; };
const copy = async name => { const file = path.join(root, name); await fs.copyFile(base, file); return file; };
const checkReleased = m => {
  assert.equal(m.children.size, 0); assert.equal(m.exits.size, 0); assert.equal(m.handles.size, 0);
  assert.equal(m.work.size, 0); assert.equal(m.closes.size, 0); assert.equal(m.probes, 0);
};
const rejected = async (m, file, code = 'MEDIA_IDENTITY_UNAVAILABLE') => {
  await assert.rejects(fingerprint(file, m), { code }); checkReleased(m);
};

before(async () => {
  if (!available) return;
  const parent = fileURLToPath(new URL('../collab/results/video-desktop/', import.meta.url));
  await fs.mkdir(parent, { recursive: true });
  root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'content-identity-test-')));
  base = await variant('base.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '0.8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac']);
  baseline = await fingerprint(base);
  ({ stdout: flat } = await exec('ffprobe', ['-v', 'error', '-nofind_stream_info', '-show_packets', '-show_streams', '-show_format', '-show_chapters', '-show_programs', '-show_data_hash', 'sha256', '-of', 'flat', base], { maxBuffer: 1048576 }));
});

after(async () => {
  for (const m of active) { await m.close(); checkReleased(m); }
  if (root) await fs.rm(root, { recursive: true, force: true });
});

// Walk only our tiny synthetic ISO-BMFF fixture; callback edits a selected atom.
function editAtom(b, wanted, edit, start = 0, end = b.length) {
  let count = 0;
  for (let at = start; at < end;) {
    const length = b.readUInt32BE(at), type = b.toString('latin1', at + 4, at + 8);
    assert.ok(length >= 8 && at + length <= end);
    if (type === wanted) { edit(b.subarray(at + 8, at + length)); count++; }
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf'].includes(type)) count += editAtom(b, wanted, edit, at + 8, at + length);
    at += length;
  }
  return count;
}
async function edited(name, type, edit) {
  const b = await fs.readFile(base); assert.ok(editAtom(b, type, edit) > 0);
  const file = path.join(root, name); await fs.writeFile(file, b); return file;
}
async function packetHashes(file) {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-nofind_stream_info', '-show_packets', '-show_entries', 'packet=stream_index,data_hash', '-show_data_hash', 'sha256', '-of', 'json', file], { maxBuffer: 1048576 });
  const streams = new Map();
  for (const p of JSON.parse(stdout).packets) { if (!streams.has(p.stream_index)) streams.set(p.stream_index, []); streams.get(p.stream_index).push(p.data_hash); }
  return [...streams].sort(([a], [b]) => a - b);
}
let fakeNumber = 0;
async function fake(code, probeMs = 10000) {
  const file = path.join(root, `probe literal ; ${++fakeNumber}.mjs`);
  await fs.writeFile(file, `#!${process.execPath}\n${code}\n`, { mode: 0o700 });
  return media({ command: file, probeMs });
}

test('returns a versioned media digest, complete SHA256, playback data and current stat identity', options, async () => {
  assert.equal(baseline.version, 'sg-media-content-v1');
  assert.match(baseline.hash, /^[a-f0-9]{64}$/);
  assert.equal(baseline.fileHash, createHash('sha256').update(await fs.readFile(base)).digest('hex'));
  assert.equal(baseline.durationMs, 800); assert.equal(baseline.codec, 'h264'); assert.equal(baseline.supported, true);
  assert.equal(baseline.identity.size, (await fs.stat(base)).size);
  assert.deepEqual((await fingerprint(base)), baseline);
});

test('Adobe XMP-only edits compare equal while whole-file hashes differ', options, async () => {
  const file = await copy('xmp.mp4');
  const xml = Buffer.from('<x:xmpmeta xmlns:x="adobe:ns:meta/"><revision>2</revision></x:xmpmeta>');
  const box = Buffer.alloc(24 + xml.length); box.writeUInt32BE(box.length); box.write('uuid', 4);
  Buffer.from('be7acfcb97a942e89c71999491e3afac', 'hex').copy(box, 8); xml.copy(box, 24);
  await fs.appendFile(file, box);
  const result = await fingerprint(file);
  assert.equal(result.hash, baseline.hash); assert.notEqual(result.fileHash, baseline.fileHash);
  assert.deepEqual(await packetHashes(file), await packetHashes(base));
});

test('title, comment, encoder and creation-time-only remuxes compare equal', options, async () => {
  const file = await variant('text-metadata.mp4', ['-i', base, '-map', '0', '-c', 'copy', '-metadata', 'title=Second title', '-metadata', 'comment=New comment', '-metadata', 'creation_time=2024-01-01T00:00:00Z']);
  const result = await fingerprint(file);
  assert.equal(result.hash, baseline.hash); assert.notEqual(result.fileHash, baseline.fileHash);
});

test('identical packet payloads with changed timestamps/playback speed compare different', options, async () => {
  const file = await variant('slower.mp4', ['-itsscale', '2', '-i', base, '-map', '0', '-c', 'copy']);
  assert.deepEqual(await packetHashes(file), await packetHashes(base));
  assert.notEqual((await fingerprint(file)).hash, baseline.hash);
});

test('audio/video relative start changes compare different without changing payloads', options, async () => {
  const file = await variant('sync.mp4', ['-i', base, '-itsoffset', '0.2', '-i', base, '-map', '0:v', '-map', '1:a', '-c', 'copy']);
  assert.deepEqual(await packetHashes(file), await packetHashes(base));
  assert.notEqual((await fingerprint(file)).hash, baseline.hash);
});

test('rotation matrices, colour metadata and movie duration are protected with unchanged packet payloads', options, async () => {
  const rotate = await edited('rotate.mp4', 'tkhd', b => {
    if (b.readUInt16BE(36) !== 0) return; // only the video track (audio has nonzero volume)
    [0, -65536, 0, 65536, 0, 0, 0, 0, 1073741824].forEach((v, i) => b.writeInt32BE(v, 40 + i * 4));
  });
  const colour = await variant('colour.mp4', ['-i', base, '-map', '0', '-c', 'copy', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709']);
  const duration = await edited('movie-duration.mp4', 'mvhd', b => b.writeUInt32BE(b.readUInt32BE(16) + b.readUInt32BE(12), 16));
  for (const file of [rotate, colour, duration]) {
    assert.deepEqual(await packetHashes(file), await packetHashes(base));
    assert.notEqual((await fingerprint(file)).hash, baseline.hash);
  }
  assert.equal((await fingerprint(duration)).durationMs, 1800);
});

test('audio removal, additional audio, audio content and video content changes compare different', options, async () => {
  const files = [
    await variant('silent.mp4', ['-i', base, '-map', '0:v', '-c', 'copy']),
    await variant('extra-audio.mp4', ['-i', base, '-map', '0', '-map', '0:a', '-c', 'copy']),
    await variant('other-audio.mp4', ['-i', base, '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-map', '0:v', '-map', '1:a', '-t', '0.8', '-c:v', 'copy', '-c:a', 'aac']),
    await variant('other-video.mp4', ['-i', base, '-vf', 'negate', '-c:v', 'libx264', '-c:a', 'copy']),
  ];
  for (const file of files) assert.notEqual((await fingerprint(file)).hash, baseline.hash);
});

test('known WebM VP9/Opus streams and MOV/M4V containers work without decoding', options, async () => {
  const webm = await variant('known.webm', ['-f', 'lavfi', '-i', 'color=c=blue:s=64x48:r=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '0.8', '-c:v', 'libvpx-vp9', '-c:a', 'libopus']);
  const result = await fingerprint(webm); assert.equal(result.codec, 'vp9'); assert.equal(result.supported, true);
  assert.ok(result.durationMs >= 800 && result.durationMs <= 820);
  for (const ext of ['mov', 'm4v']) assert.equal((await fingerprint(await variant(`known.${ext}`, ['-i', base, '-map', '0', '-c', 'copy']))).codec, 'h264');
});

test('browser-unsupported MPEG4 can still get a reliable content identity', options, async () => {
  const file = await variant('browser-unsupported.mp4', ['-i', base, '-c:v', 'mpeg4', '-c:a', 'copy']);
  const value = await fingerprint(file); assert.equal(value.codec, 'mpeg4'); assert.equal(value.supported, false);
  assert.match(value.hash, /^[a-f0-9]{64}$/);
});

test('unknown metadata, UUID boxes and extra subtitle tracks fail closed', options, async () => {
  const metadata = await variant('unknown-metadata.mp4', ['-i', base, '-map', '0', '-c', 'copy', '-movflags', 'use_metadata_tags', '-metadata', 'unrecognised_playback=1']);
  await rejected(media(), metadata);
  const uuid = await copy('unknown-uuid.mp4');
  const box = Buffer.alloc(24); box.writeUInt32BE(24); box.write('uuid', 4); await fs.appendFile(uuid, box);
  await rejected(media(), uuid);
  const srt = path.join(root, 'own.srt'); await fs.writeFile(srt, '1\n00:00:00,000 --> 00:00:00,500\nSynthetic subtitle\n');
  const subtitle = await variant('subtitle.mp4', ['-i', base, '-i', srt, '-map', '0', '-map', '1', '-c', 'copy', '-c:s', 'mov_text']);
  await rejected(media(), subtitle);
});

test('unknown packet/stream side data and absent packet hashes are not comparable', options, async () => {
  const cases = [
    flat.replace('packets.packet.0.data_hash=', 'packets.packet.0.side_data_list.side_data.0.side_data_type="Unrecognised playback"\npackets.packet.0.data_hash='),
    flat + 'streams.stream.0.side_data_list.side_data.0.side_data_type="Unknown HDR config"\n',
    flat.replace(/^packets\.packet\.0\.data_hash=.*\n/m, ''),
    flat + 'format.tags.unrecognised_playback="1"\n',
  ];
  for (const output of cases) await rejected(await fake(`process.stdout.write(${JSON.stringify(output)});`), base);
});

test('per-stream packet order, codec extradata and skip-sample trim counts all affect identity', options, async () => {
  const hashes = [...flat.matchAll(/^packets\.packet\.[01]\.data_hash=(.*)$/gm)].map(m => m[1]); assert.equal(hashes.length, 2);
  const swapped = flat.replace(/^(packets\.packet\.0\.data_hash=).*$/m, '$1' + hashes[1]).replace(/^(packets\.packet\.1\.data_hash=).*$/m, '$1' + hashes[0]);
  const extradata = flat.replace(/^(streams\.stream\.0\.extradata_hash=).*$/m, '$1"SHA256:' + '0'.repeat(64) + '"');
  const trimmed = flat.replace(/^(packets\.packet\.\d+\.side_data_list\.side_data\.0\.skip_samples=)1024$/m, '$12048');
  assert.notEqual(trimmed, flat);
  for (const output of [swapped, extradata, trimmed]) {
    const m = await fake(`process.stdout.write(${JSON.stringify(output)});`);
    assert.notEqual((await fingerprint(base, m)).hash, baseline.hash); checkReleased(m);
  }
});

test('truncated/versioned container headers and excessive nesting fail with the agreed unavailable code', options, async () => {
  const invalid = await edited('invalid-mvhd.mp4', 'mvhd', b => { b[0] = 1; });
  await rejected(media(), invalid);
  const file = path.join(root, 'too-deep.mp4'); let b = Buffer.alloc(8); b.writeUInt32BE(8); b.write('free', 4);
  for (let i=0; i<30; i++) { const header=Buffer.alloc(8); header.writeUInt32BE(b.length+8); header.write('moov',4); b=Buffer.concat([header,b]); }
  await fs.writeFile(file,b); await rejected(media(),file);
});

test('probe uses inherited FD, shell:false, protocol/format allowlists and explicitly disables decoding', options, async () => {
  const expected = await fs.stat(base);
  const m = await fake(`
    import fs from 'node:fs'; import assert from 'node:assert/strict';
    const a = process.argv.slice(2), option = k => a[a.indexOf(k)+1];
    assert.equal(a.at(-1), '/dev/fd/3'); assert.equal(a.includes(${JSON.stringify(base)}), false);
    assert.ok(a.includes('-nofind_stream_info')); assert.ok(!a.includes('-show_frames'));
    assert.equal(option('-protocol_whitelist'), 'file,pipe'); assert.equal(option('-format_whitelist'), 'mov,matroska');
    assert.equal(fs.fstatSync(3).ino, ${expected.ino});
    process.stdout.write(${JSON.stringify(flat)});
  `);
  assert.equal((await fingerprint(base, m)).hash, baseline.hash); checkReleased(m);
});

test('large streamed packet output is accepted but huge individual lines and malformed/truncated data are bounded', options, async () => {
  const header = flat.slice(flat.indexOf('streams.stream.0.index='));
  const first = flat.slice(0, flat.indexOf('packets.packet.1.'));
  const audio = flat.slice(flat.indexOf('packets.packet.2.'), flat.indexOf('packets.packet.3.'));
  // 12000 packets produce several MiB; the production path retains one packet.
  const m = await fake(`
    import { once } from 'node:events';
    for (let i=0;i<12000;i++) {
      const s=(${JSON.stringify(first)}).replaceAll('packets.packet.0.', 'packets.packet.'+i+'.');
      if (!process.stdout.write(s)) await once(process.stdout,'drain');
    }
    process.stdout.write((${JSON.stringify(audio)}).replaceAll('packets.packet.2.', 'packets.packet.12000.'));
    process.stdout.write(${JSON.stringify(header)});
  `, 30000);
  assert.match((await fingerprint(base, m)).hash, /^[a-f0-9]{64}$/); checkReleased(m);
  for (const code of [`process.stdout.write('x'.repeat(200000));`, `process.stdout.write('not valid output\\n');`, `process.stdout.write(${JSON.stringify(first)});`]) await rejected(await fake(code), base);
});

test('same-size mutation during file hashing is rejected even if mtime is restored', options, async () => {
  const file = await copy('mutating.mp4'), original = await fs.stat(file), m = media();
  const open = m.open.bind(m); let mutated = false;
  m.open = async source => {
    const opened = await open(source), read = opened.handle.read.bind(opened.handle);
    opened.handle.read = async (...args) => {
      const result = await read(...args);
      if (!mutated) {
        mutated = true; const edit = await fs.open(file, 'r+');
        try { await edit.write(Buffer.from([123]), 0, 1, 100); } finally { await edit.close(); }
        await fs.utimes(file, original.atime, original.mtime);
      }
      return result;
    };
    return opened;
  };
  await rejected(m, file, 'SOURCE_CHANGED'); assert.equal(mutated, true);
});

test('path replacement during hashing and file change during ffprobe discard all results', options, async () => {
  const file = await copy('replaced.mp4'), replacement = await copy('replacement.mp4'), m = media();
  const open = m.open.bind(m); let replaced = false;
  m.open = async source => {
    const opened = await open(source), read = opened.handle.read.bind(opened.handle);
    opened.handle.read = async (...args) => { const result = await read(...args); if (!replaced) { replaced = true; await fs.rename(replacement, file); } return result; };
    return opened;
  };
  await rejected(m, file, 'SOURCE_CHANGED');
  const probing = await copy('probe-mutated.mp4');
  const fakeMedia = await fake(`import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(probing)}, 'changed'); process.stdout.write(${JSON.stringify(flat)});`);
  await rejected(fakeMedia, probing, 'SOURCE_CHANGED');
});

test('unavailable probe, timeout, busy and closing release children, descriptors and reservations', options, async () => {
  await rejected(media({ command: path.join(root, 'does-not-exist') }), base);
  await rejected(await fake('setInterval(()=>{},1000);', 100), base, 'PROBE_TIMEOUT');
  const m = await fake('setInterval(()=>{},1000);');
  const pending = fingerprint(base, m); const rejectedPending = assert.rejects(pending, { code: 'VIDEO_CLOSING' });
  while (!m.children.size) await new Promise(resolve => setTimeout(resolve, 5));
  await m.close(); await rejectedPending; checkReleased(m);
  const busy = media(); busy.probes = 2;
  await assert.rejects(fingerprint(base, busy), { code: 'PROBE_BUSY' }); busy.probes = 0; checkReleased(busy);
});

test('capability checks only executable availability, including PATH command names', options, async () => {
  const m = media();
  assert.deepEqual(await mediaContentFingerprintCapability(m), { available: true, version: 'sg-media-content-v1' }); checkReleased(m);
  const missing = media({ command: path.join(root, 'missing-tool') });
  assert.deepEqual(await mediaContentFingerprintCapability(missing), { available: false, version: 'sg-media-content-v1', code: 'MEDIA_IDENTITY_UNAVAILABLE' }); checkReleased(missing);
  const noSpawn = await fake('throw Error("capability must never execute this");');
  assert.equal((await mediaContentFingerprintCapability(noSpawn)).available, true); checkReleased(noSpawn);
});
