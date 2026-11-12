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
let server, browser, releaseEpisode;

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
  server = {
    child, logs: () => logs,
    exited: new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))),
  };
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
}

async function stop() {
  if (!server) return;
  const { child, exited, logs } = server;
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  let timer;
  const outcome = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve(null), 20000); })]);
  clearTimeout(timer);
  assert.deepEqual(outcome, { code: 0, signal: null }, 'isolated app should stop normally\n' + logs());
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
const identityAlert = page => page.locator('.banner[role="alert"]').filter({ hasText: '素材库已变化，请刷新页面后重新读取项目' });

try {
  await start('a');
  const a = await seed('仅库甲有的剧');
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1480, height: 1000 } });
  await context.addInitScript(() => {
    try { localStorage.setItem('shiguang.refreshSeconds', sessionStorage.getItem('test.directoryRefresh') ?? '0'); } catch {}
  });
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
    await page.waitForLoadState('networkidle', { timeout: 10000 });
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
  await expect(identityAlert(page)).toBeVisible();
  await expect(card(page, b.series.name)).toHaveCount(0);
  assert.equal(await savedLocation(page, a.instanceId), aLocation);
  assert.equal(await savedLocation(page, b.instanceId), null);
  console.log('PASS 乙库新标签建立会话后，旧甲标签重试仍会拒绝乙库，并保留甲库记忆');

  await page.evaluate(() => sessionStorage.setItem('test.directoryRefresh', '15'));
  await page.reload();
  await card(page, b.series.name).dblclick();
  await expect(heading(page, b.series.name)).toBeVisible();
  assert.deepEqual(JSON.parse(await savedLocation(page, b.instanceId)), { level: 'series', seriesId: b.series.id });
  assert.equal(await savedLocation(page, a.instanceId), aLocation);
  console.log('PASS 刷新后可正常使用乙库，两个库的位置独立保存');

  const episodePath = `/api/project-series/${b.series.id}/episodes`;
  let episodeReply;
  const release = new Promise(resolve => { releaseEpisode = resolve; });
  await page.route(url => url.pathname === episodePath, async route => {
    const response = await route.fetch();
    episodeReply = { status: response.status(), body: await response.json() };
    await release;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '新建第 1 集（剧里）', exact: true }).click();
  await expect.poll(() => episodeReply?.status).toBe(200);
  assert.ok(episodeReply.body.project.id, 'the old library has already committed the episode');

  await stop();
  await start('a');
  await other.goto('about:blank');
  await other.goto(origin + '/#/projects');
  await expect(card(other, a.series.name)).toBeVisible();
  await page.bringToFront();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(identityAlert(page)).toBeVisible();
  await page.evaluate(pathname => {
    const parse = Response.prototype.json;
    Response.prototype.json = async function () {
      const body = await parse.call(this);
      if (this.url && new URL(this.url).pathname === pathname) {
        Response.prototype.json = parse;
        // Wait for the consumer of the parsed receipt and the resulting render.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          document.documentElement.dataset.episodeReceiptConsumed = 'yes';
        }));
      }
      return body;
    };
  }, episodePath);
  releaseEpisode();
  await expect(page.locator('html')).toHaveAttribute('data-episode-receipt-consumed', 'yes');
  await page.getByRole('button', { name: '生成视频', exact: true }).click();
  await expect(page.getByRole('heading', { name: '先选择一个项目', exact: true })).toBeVisible();
  console.log('PASS 已写入原库的迟到回执保留成功语义，旧标签不会重新选中原项目');
} finally {
  releaseEpisode?.();
  try { await browser?.close(); }
  finally {
    await stop();
    await rm(temp, { recursive: true, force: true });
  }
}
