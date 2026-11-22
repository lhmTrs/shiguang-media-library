// 真实索引服务的合成资产夹具：一个合成音乐库（两个根目录、一对待合并的资产）加一个独立子进程里的真实 server/index.mjs。
// 与 tests/asset-merge-routes.test.mjs 里的 seed/server 同源；asset-metadata-registration 以前在运行时拼接那个测试文件的源码，
// 那边一改导入或签名（#128 加了 temp-cleanup、改成 seed(t)）这边就坏，所以抽到这里。
// 只用调用方给的临时目录，不碰真实库和 4317；子进程用临时端口，用例结束时停掉。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Library} from '../../server/library.mjs';
import {AssetFingerprints} from '../../server/asset-fingerprints.mjs';
import {reconcileRoot} from '../../server/reconcile.mjs';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const opts = {tagFiles: false, hashBudgetFiles: 0, hashBudgetBytes: 0, matchHashBudgetFiles: 0};

/**
 * 在 base 下建合成库：canonical（原文件已移走、留有指纹）和 donor（同内容新位置）。
 * registerMetadata=false 时不预先登记字段版本，供“显式登记”测试从未登记状态开始。
 */
export async function seedAssetLibrary(base, {registerMetadata = true} = {}) {
  const data = path.join(base, 'data'), lib = await new Library(data, {directoryClassification: true}).init();
  lib.enqueue = () => {};
  const roots = [];
  for (const name of ['source', 'target']) {
    const dir = path.join(base, name);
    await fs.mkdir(path.join(dir, '类别'), {recursive: true});
    roots.push(await lib.addRoot(dir, 'music'));
  }
  const original = path.join(roots[0].path, '类别/old.wav'), target = path.join(roots[1].path, '类别/new.wav');
  await fs.writeFile(original, 'real authenticated merge bytes');
  await reconcileRoot(lib, roots[0], opts);
  const canonical = lib.db.prepare('SELECT id FROM assets').get().id;
  if (registerMetadata) lib.metadataVersions.register();
  lib.patch(canonical, {note: 'canonical old', tags: ['old'], favorite: true, confirmed: true, capturedAt: '2026-10-20T12:00'});
  const fp = new AssetFingerprints(lib), task = fp.start({mode: 'fingerprint', assetIds: [canonical]});
  assert.equal((await fp.wait(task.id)).saved, 1);
  await fp.dispose();
  await fs.copyFile(original, target);
  await fs.rename(original, path.join(base, 'retained-old.wav'));
  await reconcileRoot(lib, roots[1], opts);
  const donor = lib.db.prepare('SELECT id FROM assets WHERE path=?').get(target).id;
  lib.patch(donor, {note: 'temporary', tags: ['new'], favorite: true, confirmed: true, capturedAt: '2026-10-21T12:00'});
  lib.patch(donor, {note: '', favorite: false, confirmed: false, capturedAt: ''});
  lib.db.prepare("UPDATE assets SET probe='ready',capture_status='ready'").run();
  lib.db.close();
  const helper = crypto.createHash('sha256').update(await fs.readFile(path.join(repo, 'server/trash.swift'))).digest('hex').slice(0, 12);
  await fs.writeFile(path.join(data, 'trash-helper-' + helper), 'private non-executable test marker', {mode: 0o600});
  const home = path.join(base, 'home'), tmp = path.join(base, 'tmp');
  await fs.mkdir(home);
  await fs.mkdir(tmp);
  return {base, data, home, tmp, target, canonical, donor, roots, input: {canonicalAssetId: canonical, donorAssetId: donor}};
}

// 子进程里注入的受控故障，只作用于该子进程自己的数据目录。
const mirrorFaultShim = "const open=fs.open;let failed=false;fs.open=async(file,...args)=>{const h=await open(file,...args);if(String(file).includes('manifest.json.tmp-')){const write=h.writeFile.bind(h);h.writeFile=async(data,...rest)=>{if(!failed&&String(data).includes('COMPLETE')){failed=true;throw Object.assign(Error('controlled private manifest fault'),{code:'EIO'});}return write(data,...rest);};}return h;};";
const fieldFaultShim = "const fieldOpen=fs.open;let fieldFailed=false;fs.open=async(file,...args)=>{const h=await fieldOpen(file,...args);if(String(file).includes('/asset-metadata-registration/')){const write=h.writeFile.bind(h);h.writeFile=async(data,...rest)=>{if(!fieldFailed&&String(data).includes('\"phase\":\"READY\"')){fieldFailed=true;throw Object.assign(Error('controlled receipt write failure'),{code:'EIO'});}return write(data,...rest);};}return h;};";
const fieldGateShim = "let releaseField;const heldField=new Promise(r=>releaseField=r);process.on('message',m=>{if(m?.type==='release-field')releaseField();});const gateOpen=fs.open;let fieldEntered=false;fs.open=async(file,...args)=>{const h=await gateOpen(file,...args);if(!fieldEntered&&String(file).includes('/asset-metadata-registration/')&&String(file).endsWith('.before.json')){const sync=h.sync.bind(h);h.sync=async()=>{fieldEntered=true;process.send({type:'field-entered'});await heldField;return sync();};}return h;};";

/**
 * 在独立子进程里启动真实 server/index.mjs，取会话 cookie 和本机令牌。
 * register：按需登记云上传宿主；listenPort：指定端口（重启后沿用原端口）；
 * fieldGate：字段登记写 before.json 时停住，等 releaseField() 再继续。
 */
export async function startIndexServer(t, f, {register = true, mirrorFault = false, fieldFault = false, fieldGate = false, listenPort = 0} = {}) {
  const socket = net.createServer();
  await new Promise((r, j) => {socket.once('error', j); socket.listen(listenPort, '127.0.0.1', r);});
  const port = socket.address().port;
  await new Promise(r => socket.close(r));
  const code = `import fs from'node:fs/promises';${fieldGate ? fieldGateShim : ''}${fieldFault ? fieldFaultShim : ''}${mirrorFault ? mirrorFaultShim : ''}await import(${JSON.stringify(new URL('../../server/index.mjs', import.meta.url).href)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {cwd: repo, env: {PATH: process.env.PATH, HOME: f.home, MEDIA_DISABLE_DESKTOP_NATIVE: '1', TMPDIR: f.tmp, LANG: 'en_US.UTF-8', MEDIA_DATA_DIR: f.data, MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_CLOUD_AUDIO_ENABLED: '1', SHIGUANG_AUDIO_ANALYSIS: '', SHIGUANG_CLOUD_RELEASE_CONFIG: path.join(f.base, 'absent-release.json'), PORT: String(port), NODE_ENV: 'production'}, stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
  let resolveFieldGate;
  const fieldGateEntered = new Promise(r => resolveFieldGate = r);
  child.on('message', m => {if (m?.type === 'field-entered') resolveFieldGate();});
  let closed = false, output = '';
  child.stdout.on('data', b => output = (output + b).slice(-32768));
  child.stderr.on('data', b => output = (output + b).slice(-32768));
  const ended = new Promise(r => {
    child.once('error', e => {closed = true; output += e.message; r();});
    child.once('close', (exit, signal) => {closed = true; console.log(JSON.stringify({pid: child.pid, exit, signal, knownClosed: true})); r();});
  });
  const stop = async () => {if (!closed) child.kill('SIGTERM'); await ended;};
  t.after(stop);
  const deadline = Date.now() + 10000;
  while (true) {
    assert.equal(closed, false, output);
    assert.ok(Date.now() < deadline, 'private server ready');
    try {
      const state = JSON.parse(await fs.readFile(path.join(f.data, 'server.json'), 'utf8'));
      if (state.pid === child.pid) break;
    } catch (e) {if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;}
    await new Promise(r => setTimeout(r, 20));
  }
  const origin = 'http://127.0.0.1:' + port, response = await fetch(origin + '/api/session');
  assert.equal(response.status, 200);
  const token = (await response.json()).token, cookie = response.headers.get('set-cookie').split(';')[0];
  const get = route => fetch(origin + '/api' + route, {headers: {cookie}});
  const post = (route, body, headers = {}) => fetch(origin + '/api' + route, {method: 'POST', headers: {cookie, origin, 'content-type': 'application/json', 'x-local-token': token, ...headers}, body: JSON.stringify(body)});
  if (register) {
    const readiness = await (await get('/cloud-upload-host/readiness')).json();
    if (!readiness.ready) {
      const r = await post('/cloud-upload-host/register', {clientCommandId: crypto.randomUUID(), expectedVersion: readiness.version, assetIds: [f.canonical, f.donor]});
      assert.equal(r.status, 200, await r.clone().text());
      assert.equal((await r.json()).ready, true);
    }
  }
  return {origin, cookie, token, get, post, stop, fieldGateEntered, releaseField: () => child.send({type: 'release-field'})};
}
