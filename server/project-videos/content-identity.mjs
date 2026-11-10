import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { constants } from 'node:fs';

const VERSION = 'sg-media-content-v1';
const LIMIT = { line: 65536, header: 1048576, field: 262144, streams: 16, packet: 65536, elements: 2000000 };
const stamp = s => ({ dev: String(s.dev), ino: String(s.ino), size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs });
const same = (a, b) => Object.keys(a).every(k => a[k] === b[k]);
const error = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const unavailable = () => error('MEDIA_IDENTITY_UNAVAILABLE', '此媒体的轨道、元数据或结构无法安全比较');
const requireValue = condition => { if (!condition) throw unavailable(); };
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
const integer = v => { requireValue(typeof v === 'string' && /^-?\d{1,24}$/.test(v)); return BigInt(v).toString(); };
const decimal = v => v !== undefined && v !== 'N/A' && /^-?\d+(?:\.\d+)?$/.test(v) && Number.isFinite(Number(v));
const positive = v => decimal(v) && Number(v) > 0;
const dataHash = v => { requireValue(/^SHA256:[a-fA-F0-9]{64}$/.test(v || '')); return v.slice(7).toLowerCase(); };
const ignoredTags = new Set(['title', 'comment', 'description', 'creation_time', 'date', 'encoder', 'software', 'handler_name', 'vendor_id', 'xmp', 'xmp_', 'com_adobe_xmp', 'xml__com_adobe_xmp']);
const playbackTags = new Set(['language', 'duration', 'rotate']);
const formatTags = new Set(['major_brand', 'minor_version', 'compatible_brands']);

function tags(fields, prefix, format = false) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!key.startsWith(prefix)) continue;
    const tag = key.slice(prefix.length).toLowerCase();
    if (ignoredTags.has(tag) || format && formatTags.has(tag)) continue;
    requireValue(playbackTags.has(tag));
    out[tag] = value;
  }
  return out;
}

// Read bounded container headers from the SAME descriptor used by ffprobe and
// the whole-file digest. These cover playback information a no-decode probe may
// omit (notably MOV movie duration, track volume/flags, edit lists and matrices).
async function containerIdentity(handle, size, ext, check) {
  let elements = 0;
  let durationSeconds = null;
  const fields = [];
  const read = async (offset, length) => {
    check();
    requireValue(length >= 0 && length <= LIMIT.field && offset + length <= size);
    const b = Buffer.alloc(length);
    let n = 0;
    while (n < length) { const r = await handle.read(b, n, length - n, offset + n); requireValue(r.bytesRead > 0); n += r.bytesRead; }
    return b;
  };
  const add = (key, b) => { requireValue(fields.length < 4096); fields.push([key, digest(b)]); };
  if (ext !== '.webm') {
    const containers = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'meta', 'ilst']);
    const storage = new Set(['ftyp', 'mdat', 'free', 'skip', 'wide', 'stco', 'co64', 'stsc', 'stsz', 'stz2']);
    const properties = new Set(['mvhd', 'tkhd', 'mdhd', 'elst', 'stsd', 'stts', 'ctts', 'stss', 'sdtp', 'sgpd', 'sbgp', 'cslg', 'vmhd', 'smhd', 'gmin', 'gmhd', 'fiel', 'pasp', 'colr']);
    const metadata = new Set(['©nam', '©cmt', '©day', '©too', '©swr', 'desc', 'ldes', 'XMP_']);
    let movies = 0, tracks = 0;
    async function scan(start, end, parent, depth = 0) {
      requireValue(depth <= 24);
      const occurrences = new Map();
      for (let at = start; at < end;) {
        requireValue(++elements <= LIMIT.elements && end - at >= 8);
        const h = await read(at, Math.min(16, end - at));
        const type = h.toString('latin1', 4, 8);
        let length = h.readUInt32BE(0), header = 8;
        if (length === 1) { requireValue(h.length === 16); const n = h.readBigUInt64BE(8); requireValue(n <= BigInt(Number.MAX_SAFE_INTEGER)); length = Number(n); header = 16; }
        if (length === 0) length = end - at;
        requireValue(length >= header && at + length <= end);
        const from = at + header, bytes = length - header;
        const occurrence = occurrences.get(type) || 0;
        occurrences.set(type, occurrence + 1);
        const key = `${parent}/${type}:${occurrence}`;
        if (type === 'uuid') {
          requireValue(bytes >= 16 && (await read(from, 16)).toString('hex') === 'be7acfcb97a942e89c71999491e3afac'); // Adobe XMP only
        } else if (containers.has(type)) {
          if (type === 'moov') movies++;
          if (type === 'trak') tracks++;
          if (type === 'meta') requireValue(bytes >= 4 && (await read(from, 4)).equals(Buffer.alloc(4)));
          await scan(from + (type === 'meta' ? 4 : 0), at + length, key, depth + 1);
        } else if (storage.has(type) || metadata.has(type) && (parent.includes('/udta:') || parent.includes('/ilst:'))) {
          // Physical offsets, padding, and the explicitly named text metadata.
        } else if (type === 'hdlr') {
          const b = await read(from, bytes);
          requireValue(b.length >= 24);
          add(key, b.subarray(0, 24)); // name is informational; handler type is not
        } else if (type === 'dref') {
          const b = await read(from, bytes);
          requireValue(b.length === 20 && b.readUInt32BE(4) === 1 && b.readUInt32BE(8) === 12 && b.toString('ascii', 12, 16) === 'url ' && b.readUInt32BE(16) === 1);
        } else if (properties.has(type)) {
          const b = await read(from, bytes);
          if (['mvhd', 'tkhd', 'mdhd'].includes(type)) {
            requireValue(b.length >= 24 && (b[0] === 0 || b[0] === 1));
            const minimum = { mvhd: [100, 112], tkhd: [84, 96], mdhd: [24, 36] };
            requireValue(b.length >= minimum[type][b[0]]);
            if (type === 'mvhd') {
              const scale = b.readUInt32BE(b[0] === 1 ? 20 : 12);
              const ticks = b[0] === 1 ? Number(b.readBigUInt64BE(24)) : b.readUInt32BE(16);
              requireValue(scale > 0 && Number.isSafeInteger(ticks) && ticks > 0);
              durationSeconds = ticks / scale;
            }
            b.fill(0, 4, b[0] === 1 ? 20 : 12); // creation/modification timestamps
            if (type === 'mvhd') { requireValue(b.length >= 100); b.fill(0, b.length - 4); } // next unused track ID
          }
          add(key, b);
        } else throw unavailable();
        at += length;
      }
    }
    await scan(0, size, 'iso');
    requireValue(movies === 1 && tracks > 0 && tracks <= LIMIT.streams);
  } else {
    // WebM only: reject unrecognised EBML playback elements, chapters,
    // attachments, encryption, content encodings and block additions.
    const masters = new Set(['1a45dfa3', '18538067', '1549a966', '1654ae6b', 'ae', 'e0', 'e1', '55b0', '55d0', '1f43b675', 'a0']);
    const skip = new Set(['ec', 'bf', '114d9b74', '1c53bb6b', '1254c367', '73a4', '4461', '4d80', '5741', '73c5', '536e', 'a3', 'a1', 'a7', 'ab']);
    const keep = new Set(('4286 42f7 42f2 42f3 4282 4287 4285 2ad7b1 4489 d7 83 b9 88 55aa 9c 23e383 23314f 86 63a2 56aa 56bb 22b59c 22b59d b0 ba 54b0 54ba 54b2 54b3 54aa 54bb 54cc 54dd 9a 9d 53b8 53c0 b5 78b5 9f 6264 e7 9b fb 75a2 55b1 55b2 55b3 55b4 55b5 55b6 55b7 55b8 55b9 55ba 55bb 55bc 55bd 55d1 55d2 55d3 55d4 55d5 55d6 55d7 55d8 55d9 55da').split(' '));
    let segments = 0;
    async function scan(start, end, parent, depth = 0) {
      requireValue(depth <= 24);
      const occurrences = new Map();
      for (let at = start; at < end;) {
        requireValue(++elements <= LIMIT.elements);
        const h = await read(at, Math.min(12, end - at));
        const width = v => { let n = 1; while (n <= 8 && !(v & (1 << (8 - n)))) n++; requireValue(n <= 8); return n; };
        const idSize = width(h[0]); requireValue(idSize <= 4 && h.length > idSize);
        const id = h.subarray(0, idSize).toString('hex'), n = width(h[idSize]);
        requireValue(h.length >= idSize + n);
        let bytes = BigInt(h[idSize] & ((1 << (8 - n)) - 1));
        for (let i = 1; i < n; i++) bytes = bytes * 256n + BigInt(h[idSize + i]);
        const from = at + idSize + n;
        if (bytes === (1n << BigInt(7 * n)) - 1n) { requireValue(id === '18538067'); bytes = BigInt(end - from); }
        requireValue(bytes <= BigInt(end - from));
        const length = Number(bytes), occurrence = occurrences.get(id) || 0;
        occurrences.set(id, occurrence + 1);
        const key = `${parent}/${id}:${occurrence}`;
        if (masters.has(id)) { if (id === '18538067') segments++; await scan(from, from + length, key, depth + 1); }
        else if (skip.has(id)) { /* payload, storage index, or whitelisted metadata */ }
        else if (keep.has(id)) add(key, await read(from, length));
        else throw unavailable();
        at = from + length;
      }
    }
    await scan(0, size, 'webm');
    requireValue(segments === 1);
  }
  return { hash: digest(JSON.stringify(fields)), durationSeconds };
}

const packetFields = new Set(['codec_type', 'stream_index', 'pts', 'pts_time', 'dts', 'dts_time', 'duration', 'duration_time', 'size', 'pos', 'flags', 'data_hash']);
const streamFields = new Set(('index codec_name codec_long_name profile codec_type codec_tag_string codec_tag width height coded_width coded_height closed_captions film_grain has_b_frames sample_aspect_ratio display_aspect_ratio pix_fmt level color_range color_space color_transfer color_primaries chroma_location field_order refs is_avc nal_length_size quarter_sample divx_packed id r_frame_rate avg_frame_rate time_base start_pts start_time duration_ts duration bit_rate max_bit_rate bits_per_raw_sample nb_frames nb_read_frames nb_read_packets extradata_size extradata_hash sample_fmt sample_rate channels channel_layout bits_per_sample initial_padding trailing_padding').split(' '));
const ignoredStreamFields = new Set(['codec_long_name', 'id', 'bit_rate', 'max_bit_rate', 'nb_frames', 'nb_read_frames', 'nb_read_packets']);
const dispositions = new Set(('default dub original comment lyrics karaoke forced hearing_impaired visual_impaired clean_effects attached_pic timed_thumbnails non_diegetic captions descriptions metadata dependent still_image').split(' '));
const formatFields = new Set(('filename nb_streams nb_programs nb_stream_groups format_name format_long_name start_time duration size bit_rate probe_score').split(' '));
const sideFields = new Map([
  ['Display Matrix', new Set(['side_data_type', 'displaymatrix', 'rotation'])],
  ['Skip Samples', new Set(['side_data_type', 'skip_samples', 'discard_padding', 'skip_reason', 'discard_reason'])],
]);

function sideData(fields, packet) {
  const groups = new Map();
  for (const [key, value] of Object.entries(fields)) {
    if (!key.startsWith('side_data_list.')) continue;
    const m = /^side_data_list\.side_data\.(\d+)\.([a-z_]+)$/.exec(key);
    requireValue(m && Number(m[1]) < 16);
    if (!groups.has(m[1])) groups.set(m[1], {});
    groups.get(m[1])[m[2]] = value;
  }
  const out = [];
  for (const [i, values] of groups) {
    requireValue(Number(i) === out.length);
    const type = values.side_data_type, allowed = sideFields.get(type);
    requireValue(allowed && (packet ? type === 'Skip Samples' : type === 'Display Matrix'));
    requireValue(Object.keys(values).length === allowed.size && Object.keys(values).every(k => allowed.has(k)));
    if (type === 'Skip Samples') for (const [k, v] of Object.entries(values)) { if (k !== 'side_data_type') requireValue(BigInt(integer(v)) >= 0n); }
    out.push(JSON.parse(canonical(values)));
  }
  return out;
}

// Flat ffprobe output emits one bounded scalar per line. Only the current
// packet is retained; packet count does not grow JS memory consumption.
function collector() {
  const streams = new Map(), packets = new Map(), format = Object.create(null);
  let current = null, packetNumber = -1, packetBytes = 0, headerBytes = 0;
  const flush = () => {
    if (!current) return;
    const s = Number(current.stream_index);
    requireValue(Number.isInteger(s) && s >= 0 && s < LIMIT.streams && ['video', 'audio'].includes(current.codec_type));
    for (const key of Object.keys(current)) requireValue(packetFields.has(key) || key.startsWith('side_data_list.'));
    const normalized = { type: current.codec_type, pts: integer(current.pts), dts: integer(current.dts), duration: current.duration === 'N/A' ? 'N/A' : integer(current.duration), size: integer(current.size), flags: current.flags, hash: dataHash(current.data_hash), side: sideData(current, true) };
    requireValue((normalized.duration === 'N/A' || BigInt(normalized.duration) >= 0n) && BigInt(normalized.size) > 0n && /^[KD_]{2,3}$/.test(normalized.flags));
    if (!packets.has(s)) packets.set(s, { hash: createHash('sha256'), count: 0, end: null, type: current.codec_type });
    const p = packets.get(s); requireValue(p.type === current.codec_type);
    if (normalized.duration === 'N/A') p.unknownDuration = true;
    p.hash.update(canonical(normalized) + '\n'); p.count++;
    const end = BigInt(normalized.pts) + (normalized.duration === 'N/A' ? 0n : BigInt(normalized.duration));
    if (p.end === null || end > p.end) p.end = end;
    current = null;
  };
  const insert = (target, key, value) => { requireValue(!Object.hasOwn(target, key)); target[key] = value; };
  return {
    line(line) {
      const m = /^([a-zA-Z0-9_.]+)=(.*)$/.exec(line); requireValue(m);
      let value = m[2];
      if (value.startsWith('"')) {
        // The flat writer uses C escaping (also escapes apostrophes). JSON's
        // remaining string escapes are identical for the admitted scalar set.
        try { value = JSON.parse(value.replace(/\\'/g, "'")); } catch { throw unavailable(); }
      }
      requireValue(typeof value === 'string');
      const p = /^packets\.packet\.(\d+)\.(.+)$/.exec(m[1]);
      if (p) {
        const n = Number(p[1]);
        if (n !== packetNumber) { flush(); requireValue(n === packetNumber + 1); packetNumber = n; current = Object.create(null); packetBytes = 0; }
        requireValue(current !== null);
        packetBytes += Buffer.byteLength(line); requireValue(packetBytes <= LIMIT.packet);
        insert(current, p[2], value);
      } else {
        flush(); headerBytes += Buffer.byteLength(line); requireValue(headerBytes <= LIMIT.header);
        const s = /^streams\.stream\.(\d+)\.(.+)$/.exec(m[1]);
        if (s) {
          const n = Number(s[1]); requireValue(n < LIMIT.streams);
          if (!streams.has(n)) streams.set(n, Object.create(null));
          insert(streams.get(n), s[2], value);
        } else { requireValue(m[1].startsWith('format.')); insert(format, m[1].slice(7), value); }
      }
    },
    finish(container, ext) {
      flush(); requireValue(streams.size > 0 && streams.size === packets.size && Number(format.nb_streams) === streams.size && format.nb_programs === '0' && (!format.nb_stream_groups || format.nb_stream_groups === '0'));
      for (const key of Object.keys(format)) requireValue(formatFields.has(key) || key.startsWith('tags.'));
      const family = ext === '.webm' ? 'matroska,webm' : 'mov,mp4,m4a,3gp,3g2,mj2';
      requireValue(format.format_name === family);
      const normalized = [], videos = [];
      let duration = 0;
      for (const [n, s] of streams) {
        requireValue(n === normalized.length && s.index === String(n));
        const type = s.codec_type, codec = s.codec_name;
        requireValue(type === 'video' ? (ext === '.webm' ? ['vp8', 'vp9', 'av1'] : ['h264', 'hevc', 'av1', 'mpeg4', 'prores']).includes(codec) : type === 'audio' && (ext === '.webm' ? ['opus', 'vorbis'] : ['aac', 'mp3', 'alac', 'pcm_s16le', 'pcm_s24le']).includes(codec));
        const props = {};
        for (const [key, value] of Object.entries(s)) {
          if (key.startsWith('tags.') || key.startsWith('side_data_list.')) continue;
          if (key.startsWith('disposition.')) {
            const d = key.slice(12); requireValue(dispositions.has(d) && ['0', '1'].includes(value));
            if (['attached_pic', 'timed_thumbnails', 'metadata', 'dependent', 'still_image'].includes(d)) requireValue(value === '0');
          } else requireValue(streamFields.has(key));
          if (!ignoredStreamFields.has(key)) props[key] = value;
        }
        if (positive(s.extradata_size)) dataHash(s.extradata_hash);
        else requireValue(type === 'video' && ['vp8', 'vp9'].includes(codec) || codec.startsWith('pcm_') || codec === 'mp3');
        const time = /^(\d{1,12})\/(\d{1,12})$/.exec(s.time_base || ''); requireValue(time && Number(time[1]) > 0 && Number(time[2]) > 0);
        const p = packets.get(n); requireValue(p && p.type === type && p.count > 0);
        // MOV's terminal packet duration can be N/A after an edit. Its exact
        // sample timing tables and movie/track durations are hashed separately.
        if (p.unknownDuration) requireValue(ext !== '.webm' && positive(s.duration));
        const seconds = positive(s.duration) ? Number(s.duration) + (decimal(s.start_time) ? Number(s.start_time) : 0) : Number(p.end) * Number(time[1]) / Number(time[2]);
        requireValue(Number.isFinite(seconds)); duration = Math.max(duration, seconds);
        if (type === 'video') {
          // MPEG4 dimensions can remain unknown without decoding. Its complete
          // sample description (including dimensions/configuration) is hashed.
          requireValue(positive(s.width) && positive(s.height) || codec === 'mpeg4' && s.width === '0' && s.height === '0');
          videos.push(codec);
        }
        else requireValue(positive(s.sample_rate) && positive(s.channels));
        normalized.push({ props: JSON.parse(canonical(props)), tags: tags(s, 'tags.'), side: sideData(s, false), count: p.count, packets: p.hash.digest('hex') });
      }
      requireValue(videos.length > 0);
      if (container.durationSeconds !== null) duration = container.durationSeconds;
      else if (positive(format.duration)) duration = Number(format.duration);
      requireValue(duration > 0 && duration <= 86400);
      const codec = videos[0], durationMs = Math.round(duration * 1000);
      return { hash: digest(JSON.stringify({ version: VERSION, containerHash: container.hash, family, tags: tags(format, 'tags.', true), start: format.start_time, duration: format.duration, streams: normalized })), durationMs, codec, supported: ext === '.webm' ? ['vp8', 'vp9', 'av1'].includes(codec) : ['h264', 'hevc', 'av1'].includes(codec) };
    },
  };
}

async function probe(media, handle, remaining, check) {
  const result = collector();
  const args = ['-v', 'error', '-max_alloc', '67108864', '-nofind_stream_info', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov,matroska', '-show_packets', '-show_streams', '-show_format', '-show_chapters', '-show_programs', '-show_data_hash', 'sha256', '-of', 'flat', '/dev/fd/3'];
  await new Promise((resolve, reject) => {
    let failure, pending = '', stderrBytes = 0, timer;
    const decoder = new StringDecoder('utf8');
    const child = spawn(media.command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', handle.fd] });
    media.children.add(child);
    media.exits.set(child, new Promise(done => child.once('close', done)));
    const stop = e => { failure ||= e; child.kill('SIGKILL'); };
    child.stdout.on('data', b => {
      if (failure) return;
      try {
        check(); pending += decoder.write(b);
        let end;
        while ((end = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1);
          requireValue(Buffer.byteLength(line) <= LIMIT.line);
          if (line) result.line(line);
        }
        requireValue(Buffer.byteLength(pending) <= LIMIT.line);
      } catch (e) { stop(e); }
    });
    child.stderr.on('data', b => { stderrBytes += b.length; if (stderrBytes > LIMIT.line) stop(unavailable()); });
    child.once('error', () => { failure ||= unavailable(); });
    child.once('close', (code, signal) => {
      clearTimeout(timer); media.children.delete(child); media.exits.delete(child);
      try {
        check();
        if (failure) throw failure;
        requireValue(code === 0 && !signal && stderrBytes === 0);
        pending += decoder.end(); if (pending) result.line(pending);
        resolve();
      } catch (e) { reject(e); }
    });
    timer = setTimeout(() => stop(error('PROBE_TIMEOUT', '媒体内容核验超时', 503)), Math.max(1, remaining()));
  });
  return result;
}

/** Conservative compressed-media identity. No decoding, writes, caching or DB work. */
export async function mediaContentFingerprint(media, source) {
  // FD seeking semantics on Windows have not been qualified; fail explicitly.
  if (process.platform === 'win32') throw error('MEDIA_IDENTITY_UNSUPPORTED', '当前平台尚未支持媒体内容比较');
  if (media.closing) throw error('VIDEO_CLOSING', '视频模块正在关闭', 503);
  if (media.probes >= 2 || media.children.size >= 2) throw error('PROBE_BUSY', '视频探测繁忙，请稍后重试', 429);
  const ext = path.extname(source.path).toLowerCase();
  if (!['.mp4', '.m4v', '.mov', '.webm'].includes(ext)) throw error('MEDIA_IDENTITY_UNSUPPORTED', '当前文件类型尚未支持媒体内容比较');
  const deadline = Date.now() + (Number.isFinite(media.probeMs) && media.probeMs > 0 ? media.probeMs : 10000);
  const remaining = () => deadline - Date.now();
  const check = () => {
    if (media.closing) throw error('VIDEO_CLOSING', '视频模块正在关闭', 503);
    if (remaining() <= 0) throw error('PROBE_TIMEOUT', '媒体内容核验超时', 503);
  };
  media.probes++;
  const work = (async () => {
    let opened;
    try {
      opened = await media.open(source);
      const { handle, identity } = opened;
      const stable = async () => {
        try {
          if (!same(stamp(await handle.stat()), identity) || !same(stamp(await fs.lstat(source.path)), identity) || await fs.realpath(source.path) !== source.path) throw error('SOURCE_CHANGED', '核验期间视频文件发生变化', 409);
        } catch (e) { if (e.code === 'SOURCE_CHANGED') throw e; throw error('SOURCE_CHANGED', '核验期间视频文件发生变化', 409); }
      };
      try {
        requireValue(Number.isSafeInteger(identity.size) && identity.size > 0);
        await stable();
        const file = createHash('sha256'), b = Buffer.alloc(262144);
        let offset = 0;
        while (offset < identity.size) {
          check();
          const { bytesRead } = await handle.read(b, 0, Math.min(b.length, identity.size - offset), offset);
          if (!bytesRead) throw error('SOURCE_CHANGED', '核验期间视频文件发生变化', 409);
          file.update(b.subarray(0, bytesRead)); offset += bytesRead;
        }
        await stable();
        const container = await containerIdentity(handle, identity.size, ext, check);
        const output = await probe(media, handle, remaining, check);
        const fingerprint = output.finish(container, ext);
        await stable(); check();
        return { version: VERSION, ...fingerprint, fileHash: file.digest('hex'), identity };
      } catch (e) { await stable(); throw e; }
    } finally { if (opened) await media.release(opened.handle); }
  })();
  // media.close() waits for this work as well as its child/FD close receipts.
  media.work.add(work);
  try { return await work; } finally { media.work.delete(work); media.probes--; }
}

/** Read-only executable discovery; does not probe files or claim codec support. */
export async function mediaContentFingerprintCapability(media) {
  const unavailableCapability = code => ({ available: false, version: VERSION, code });
  if (process.platform === 'win32') return unavailableCapability('MEDIA_IDENTITY_UNSUPPORTED');
  const command = media.command;
  if (typeof command !== 'string' || !command || command.includes('\0')) return unavailableCapability('MEDIA_IDENTITY_UNAVAILABLE');
  const candidates = command.includes('/') ? [command] : (process.env.PATH ?? '/usr/bin:/bin').split(path.delimiter).map(dir => path.join(dir || '.', command));
  for (const file of candidates) {
    try { await fs.access(file, constants.X_OK); if ((await fs.stat(file)).isFile()) return { available: true, version: VERSION }; } catch { /* try the next PATH entry */ }
  }
  return unavailableCapability('MEDIA_IDENTITY_UNAVAILABLE');
}
