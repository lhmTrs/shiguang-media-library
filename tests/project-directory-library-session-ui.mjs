import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await mkdtemp(path.join(os.tmpdir(), 'creative-directory-session-'));
const socket = createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const { port } = socket.address();
await new Promise(resolve => socket.close(resolve));
const origin = 'http://127.0.0.1:' + port;
let server, browser;

async function start(name) {
  const dir = path.join(temp, name);
  const child = spawn(process.execPath, ['server/index.mjs'], {
    cwd: root,
    env: {
      ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_SKIP_IMPORT: '1',
      MEDIA_DATA_DIR: path.join(dir, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(dir, 'personal'),
      CODEX_HOME: path.join(dir, 'no-codex'), MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1',
      MEDIA_CODEX_AUTOCONNECT: '0', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  server = { child, exited: new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))) };
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
}

async function stop() {
  if (!server) return;
  const { child, exited } = server;
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  let timer;
  const outcome = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(null), 10000); })]);
  clearTimeout(timer);
  assert.deepEqual(outcome, { code: 0, signal: null }, 'isolated app should stop normally');
  server = undefined;
}

async function seed(name) {
  const session = await fetch(origin + '/api/session');
  const { instanceId, token } = await session.json();
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const response = await fetch(origin + '/api/project-series', {
    method: 'POST', headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ name, request_id: crypto.randomUUID() }),
  });
  assert.equal(response.status, 200);
  return { instanceId, series: await response.json() };
}

const heading = (page, name) => page.locator('.pf').getByRole('heading', { level: 1, name, exact: true });
const card = (page, name) => page.getByRole('button', { name: '打开剧 ' + name, exact: true });
const savedLocation = (page, libraryId) => page.evaluate(id => sessionStorage.getItem('shiguang.projectFolders.loc:' + id), libraryId);

try {
  await start('a');
  const a = await seed('仅库甲有的剧');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1480, height: 1000 } });
  await context.addInitScript(() => { try { localStorage.setItem('shiguang.refreshSeconds', '0'); } catch {} });
  const page = await context.newPage();
  const retry = page.getByRole('button', { name: '重试项目目录' });
  let failDirectory = false;
  await page.route(url => url.pathname === '/api/project-series', route =>
    failDirectory ? route.fulfill({ status: 503, json: { error: '隔离测试：目录暂不可用' } }) : route.fallback());
  await page.goto(origin + '/#/projects');
  await card(page, a.series.name).dblclick();
  await expect(heading(page, a.series.name)).toBeVisible();
  const aLocation = await savedLocation(page, a.instanceId);
  assert.deepEqual(JSON.parse(aLocation), { level: 'series', seriesId: a.series.id });

  async function showRetry() {
    failDirectory = true;
    await page.reload();
    await expect(retry).toBeVisible();
    failDirectory = false;
  }

  await showRetry();
  await stop();
  await start('a');
  await retry.click();
  await expect(heading(page, a.series.name)).toBeVisible();
  console.log('PASS 同一库重启后，原标签可以恢复会话和原目录');

  await showRetry();
  await stop();
  await start('b');
  const b = await seed('仅库乙有的剧');
  assert.notEqual(a.instanceId, b.instanceId);
  const other = await context.newPage();
  await other.goto(origin + '/#/projects');
  await expect(card(other, b.series.name)).toBeVisible();
  await retry.click();
  await expect(page.locator('.banner[role="alert"]').filter({ hasText: '素材库已变化，请刷新页面后重新读取项目' })).toBeVisible();
  await expect(card(page, b.series.name)).toHaveCount(0);
  assert.equal(await savedLocation(page, a.instanceId), aLocation);
  assert.equal(await savedLocation(page, b.instanceId), null);
  console.log('PASS 乙库新标签建立会话后，旧甲标签重试仍会拒绝乙库，并保留甲库记忆');

  await page.reload();
  await card(page, b.series.name).dblclick();
  await expect(heading(page, b.series.name)).toBeVisible();
  assert.deepEqual(JSON.parse(await savedLocation(page, b.instanceId)), { level: 'series', seriesId: b.series.id });
  assert.equal(await savedLocation(page, a.instanceId), aLocation);
  console.log('PASS 刷新后可正常使用乙库，两个库的位置独立保存');
} finally {
  try { await browser?.close(); }
  finally {
    await stop();
    await rm(temp, { recursive: true, force: true });
  }
}
