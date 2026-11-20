// 项目音乐测试共用：在临时目录里起一个真实的拾光服务（全新 SQLite、临时 personal_item），只用合成音频。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

const run = promisify(execFile);
export const repo = fileURLToPath(new URL('../..', import.meta.url));

export async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

// 合成音频：正弦波或噪声，不含任何真实歌曲。
export async function synth(dir, name, {freq = 440, seconds = 2, noise = false, volume = 1} = {}) {
  const file = path.join(dir, name), ext = path.extname(name).slice(1);
  const codec = {mp3: ['-c:a', 'libmp3lame', '-b:a', '96k'], wav: ['-c:a', 'pcm_s16le'], m4a: ['-c:a', 'aac', '-b:a', '96k'], flac: ['-c:a', 'flac']}[ext];
  const source = noise ? `anoisesrc=d=${seconds}:c=pink:a=0.3` : `sine=frequency=${freq}:duration=${seconds}`;
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', source, '-af', `volume=${volume}`, '-ac', '1', '-ar', '22050', ...codec, '-y', file]);
  return file;
}

export async function startServer(t, base, {extraEnv = {}} = {}) {
  const data = path.join(base, 'data'), home = path.join(base, 'home'), tmp = path.join(base, 'tmp'), personal = path.join(base, 'personal_item');
  for (const dir of [data, home, tmp, personal]) await fs.mkdir(dir, {recursive: true});
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(repo, 'server/index.mjs')], {
    cwd: repo,
    env: {
      PATH: process.env.PATH, HOME: home, TMPDIR: tmp, LANG: 'en_US.UTF-8', MEDIA_DATA_DIR: data, MEDIA_PERSONAL_ITEM_DIR: personal,
      MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_DISABLE_DESKTOP_NATIVE: '1',
      SHIGUANG_AUDIO_ANALYSIS: '', SHIGUANG_CLOUD_RELEASE_CONFIG: path.join(base, 'absent-release.json'), PORT: String(port), NODE_ENV: 'production', ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', closed = false;
  child.stdout.on('data', b => { output = (output + b).slice(-32768); });
  child.stderr.on('data', b => { output = (output + b).slice(-32768); });
  const ended = new Promise(resolve => child.once('close', (code, signal) => { closed = true; resolve({code, signal}); }));
  const stop = async () => { if (!closed) child.kill('SIGTERM'); return ended; };
  t.after(stop);
  const deadline = Date.now() + 20000;
  while (true) {
    assert.equal(closed, false, output);
    assert.ok(Date.now() < deadline, '测试服务启动超时\n' + output);
    try { const state = JSON.parse(await fs.readFile(path.join(data, 'server.json'), 'utf8')); if (state.pid === child.pid) break; }
    catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
    await new Promise(r => setTimeout(r, 25));
  }
  const origin = `http://127.0.0.1:${port}`;
  const session = await fetch(origin + '/api/session');
  assert.equal(session.status, 200);
  const token = (await session.json()).token, cookie = session.headers.get('set-cookie').split(';')[0];
  const page = {'sec-fetch-site': 'same-origin'};
  const call = async (method, route, body, {asPage = false, headers = {}, raw = false} = {}) => {
    const h = {cookie, origin, ...(method !== 'GET' && method !== 'HEAD' ? {'x-local-token': token} : {}), ...(asPage ? page : {}), ...headers};
    let payload;
    if (body instanceof Uint8Array) { payload = body; h['content-type'] = 'application/octet-stream'; }
    else if (body !== undefined) { payload = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const res = await fetch(origin + '/api' + route, {method, headers: h, body: payload});
    if (raw) return res;
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
    return {status: res.status, body: json, text};
  };
  return {origin, port, data, personal, child, call, stop, output: () => output};
}
