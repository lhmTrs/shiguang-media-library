import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');

export async function codexTemplateUiFixture({name, distEnv, evidenceEnv, readOnly, imageFiles}) {
  const override = process.env[distEnv];
  const dist = override ? path.resolve(override) : path.join(root, 'dist');
  const entry = await fs.stat(path.join(dist, 'index.html')).catch(() => null);
  const assets = await fs.stat(path.join(dist, 'assets')).catch(() => null);
  assert.ok(entry?.isFile() && assets?.isDirectory(),
    `Missing frontend build at ${dist}. Run npm run build in ${root}, or set ${distEnv} to a built dist directory.`);

  const evidence = process.env[evidenceEnv]
    ? path.resolve(process.env[evidenceEnv])
    : await fs.mkdtemp(path.join(os.tmpdir(), name + '-evidence-'));
  await fs.mkdir(evidence, {recursive:true});
  console.log('Evidence: ' + evidence);

  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), name + '-')));
  const mock = path.join(temporary, 'fake-codex');
  const trace = path.join(temporary, 'rpc-trace.jsonl');
  const home = path.join(temporary, 'home');
  await fs.mkdir(home);
  const script = await fs.readFile(path.join(import.meta.dirname, 'fake-codex.mjs'), 'utf8');
  await fs.writeFile(mock, '#!' + process.execPath + '\n' + script, {mode:0o700});

  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const {port} = listener.address();
  await new Promise(resolve => listener.close(resolve));
  assert.notEqual(port, 4317);
  const origin = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd:root,
    env:{
      PORT:String(port),
      NODE_ENV:'production',
      HOME:home,
      MEDIA_DATA_DIR:path.join(temporary, 'data'),
      MEDIA_PERSONAL_ITEM_DIR:path.join(temporary, 'personal_item'),
      MEDIA_SKIP_IMPORT:'1',
      MEDIA_SKIP_RECONCILE:'1',
      MEDIA_NO_WATCH:'1',
      MEDIA_READONLY_FILES:readOnly ? '1' : '0',
      MEDIA_DISABLE_DESKTOP_NATIVE:'1',
      MEDIA_CLOUD_AUDIO_ENABLED:'0',
      SHIGUANG_AUDIO_ANALYSIS:'0',
      MEDIA_CODEX_AUTOCONNECT:'0',
      MEDIA_CODEX_BIN:mock,
      CODEX_HOME:path.join(home, '.codex'),
      CODEX_FAKE_TRACE:trace,
      CODEX_FAKE_IMAGE_FILES:imageFiles ? '1' : '0',
      PATH:path.join(temporary, 'no-tools'),
    },
    stdio:['ignore','pipe','pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => logs += chunk);
  child.stderr.on('data', chunk => logs += chunk);
  child.on('error', error => logs += error.message + '\n');
  const exited = new Promise(resolve => child.once('close', resolve));

  async function serveCandidate(context, external) {
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (['http:', 'https:'].includes(url.protocol) && url.origin !== origin) {
        external.push(url.origin + url.pathname);
        return route.abort();
      }
      if (override && url.origin === origin) {
        if (url.pathname === '/') return route.fulfill({path:path.join(dist, 'index.html')});
        if (url.pathname.startsWith('/assets/')) {
          const file = path.resolve(dist, '.' + decodeURIComponent(url.pathname));
          assert.ok(file.startsWith(dist + path.sep));
          return route.fulfill({path:file});
        }
      }
      return route.continue();
    });
  }

  return {evidence, temporary, trace, origin, child, exited, logs:() => logs, serveCandidate};
}
