import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { syntheticSource } from './helpers/storyboard-fixture.mjs';
import { selectProjectInBar, showPublicAssets, projectInBar } from './helpers/path-bar.mjs';

const root = path.resolve(import.meta.dirname, '..');
const evidence = path.resolve(process.env.PROJECT_SWITCH_EVIDENCE || 'collab/results/PROJECT-SWITCH-REFRESH-20261104/browser-' + Date.now());
const dist = path.resolve(process.env.PROJECT_SWITCH_DIST || path.join(root, 'dist'));
await fs.mkdir(evidence, { recursive: false });
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'project-switch-ui-'));
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port; await new Promise(r => socket.close(r));
const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, context, page, cookie, token, passed = false;
const checks = [], errors = [], external = [], held = new Set();
const child = spawn(process.execPath, ['server/index.mjs'], {
  cwd: root,
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_READONLY_FILES: '1', SHIGUANG_AUDIO_ANALYSIS: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
const exited = new Promise(r => child.once('exit', r));
async function api(url, body, method) {
  const response = await fetch(origin + '/api' + url, { method: method || (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json(); assert.ok(response.ok, url + ' ' + JSON.stringify(data)); return data;
}
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const work = () => page.getByRole('region', { name: '项目资产库' });
const list = () => work().getByRole('complementary', { name: '当前项目资产列表' });
const cards = () => list().locator('.ca-card strong');
async function settled(names) { await expect(list()).toHaveAttribute('aria-busy', 'false'); await expect(cards()).toHaveText(names); }
async function nav(name) { await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click(); }
function deferred() { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; }
async function holdResponse(match, failure = false) {
  const captured = deferred(), release = deferred(), finished = deferred();
  held.add(release);
  const handler = async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    try {
      const response = await route.fetch(); captured.resolve(); await release.promise;
      if (failure) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '合成延迟请求失败' }) });
      else await route.fulfill({ response });
    } finally { held.delete(release); finished.resolve(); }
  };
  await context.route(match, handler);
  return { captured: captured.promise, async release() { release.resolve(); await finished.promise; await context.unroute(match, handler); await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); } };
}

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const session = await fetch(origin + '/api/session'); cookie = session.headers.get('set-cookie').split(';')[0]; token = (await session.json()).token;
  const a = await api('/projects', { name: '刷新合成甲' }), b = await api('/projects', { name: '刷新合成乙' });
  const pub = (await api('/project-assets/scopes')).items.find(p => p.project_kind === 'public');
  const ca = await api('/project-assets/assets', { project_id: a.id, kind: 'character', name: '甲人物' });
  await api('/project-assets/assets', { project_id: b.id, kind: 'character', name: '乙人物' });
  await api('/project-assets/assets', { project_id: pub.id, kind: 'character', name: '公共人物' });
  await api('/project-assets/assets', { project_id: a.id, kind: 'scene', name: '甲场景' });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  context.on('request', r => { const url = new URL(r.url()); if (url.protocol.startsWith('http') && url.origin !== origin) external.push(url.origin + url.pathname); });
  // Exercise a separately built frontend against the real isolated backend. No live dist replacement.
  await context.route(origin + '/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ path: path.join(dist, 'index.html') });
    if (url.pathname.startsWith('/assets/')) {
      const file = path.resolve(dist, '.' + decodeURIComponent(url.pathname));
      assert.ok(file.startsWith(dist + path.sep)); return route.fulfill({ path: file });
    }
    return route.continue();
  });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/#/project-assets'); await selectProjectInBar(page, a.id); await settled(['甲人物']);

  await check('切换普通/公共项目立即清空旧列表和详情，保留各项目分类偏好', async () => {
    await list().locator('.ca-card').filter({ hasText: '甲人物' }).click();
    await expect(work().getByRole('heading', { name: '甲人物', exact: true })).toBeVisible();
    await work().getByLabel('搜索资产').fill('甲人物'); await settled(['甲人物']);
    const delayed = await holdResponse(url => url.pathname === '/api/project-assets/assets' && url.searchParams.get('project_id') === b.id);
    await selectProjectInBar(page, b.id); await delayed.captured;
    await expect(list()).toHaveAttribute('aria-busy', 'true'); await expect(cards()).toHaveCount(0);
    await expect(work().getByLabel('搜索资产')).toHaveValue('');
    await expect(work().getByRole('heading', { name: '甲人物', exact: true })).toHaveCount(0);
    await expect(list().getByRole('status')).toContainText('正在加载'); await delayed.release(); await settled(['乙人物']);
    await showPublicAssets(page); await settled(['公共人物']);
    await expect(work().getByRole('tab', { name: '场景', exact: true })).toBeDisabled();
    await selectProjectInBar(page, a.id); await settled(['甲人物']);
    await work().getByRole('tab', { name: '场景', exact: true }).click(); await settled(['甲场景']);
    await selectProjectInBar(page, b.id); await settled(['乙人物']);
    await selectProjectInBar(page, a.id); await settled(['甲场景']);
    await work().getByRole('tab', { name: '人物', exact: true }).click(); await settled(['甲人物']);
  });

  await check('连续切换时，旧项目延迟成功/失败均不能覆盖当前项目', async () => {
    for (const failure of [false, true]) {
      const delayed = await holdResponse(url => url.pathname === '/api/project-assets/assets' && url.searchParams.get('project_id') === b.id, failure);
      await selectProjectInBar(page, b.id); await delayed.captured;
      await selectProjectInBar(page, a.id); await settled(['甲人物']);
      await delayed.release(); await settled(['甲人物']); await expect(work().getByRole('alert')).toHaveCount(0);
    }
  });

  await check('当前项目读取失败会结束加载、显示原因，切换后可重新读取', async () => {
    const delayed = await holdResponse(url => url.pathname === '/api/project-assets/assets' && url.searchParams.get('project_id') === b.id, true);
    await selectProjectInBar(page, b.id); await delayed.captured; await delayed.release();
    await expect(work().getByRole('alert')).toContainText('合成延迟请求失败'); await expect(list()).toHaveAttribute('aria-busy', 'false'); await expect(cards()).toHaveCount(0);
    await selectProjectInBar(page, a.id); await settled(['甲人物']); await expect(work().getByRole('alert')).toHaveCount(0);
  });

  await check('从分镜返回时重新读取新增资产及当前详情的清单保护', async () => {
    await list().locator('.ca-card').filter({ hasText: '甲人物' }).click(); await expect(work().getByRole('button', { name: '归档', exact: true })).toBeEnabled();
    await nav('分镜设计');
    const source = syntheticSource(); source.characters[0].name = '甲人物'; source.asset_manifest.character[0].name = '甲人物';
    await api('/storyboard/projects/' + a.id + '/initialize', { source, expected_revision: null, request_id: randomUUID() });
    await nav('项目资产');
    await expect.poll(async () => (await cards().allTextContents()).sort()).toEqual(['不出场人物', '甲人物'].sort());
    await expect(work().getByRole('heading', { name: '甲人物', exact: true })).toBeVisible();
    await expect(work().getByRole('button', { name: '归档', exact: true })).toBeDisabled();
    await expect(work()).toContainText('已关联当前项目分镜素材清单');
  });

  await check('未保存资料跨栏目保留，取消切换保留原项目，确认后才切换', async () => {
    await work().getByLabel('基础信息', { exact: true }).fill('必须保留的本地草稿');
    await nav('分镜设计'); await nav('项目资产');
    await expect(work().getByLabel('基础信息', { exact: true })).toHaveValue('必须保留的本地草稿');
    page.once('dialog', d => d.dismiss()); await selectProjectInBar(page, b.id);
    await expect(projectInBar(page)).toHaveAttribute('data-project', a.id); await expect(work().getByLabel('基础信息', { exact: true })).toHaveValue('必须保留的本地草稿');
    page.once('dialog', d => d.accept()); await selectProjectInBar(page, b.id); await settled(['乙人物']);
    await expect(work().getByLabel('基础信息', { exact: true })).toHaveCount(0);
  });

  await check('外层项目切换同步资源，重新进入时的旧详情响应不能覆盖已保存资料', async () => {
    await nav('项目'); await page.getByRole('combobox', { name: '当前项目', exact: true }).selectOption(a.id);
    await nav('项目资产'); await expect(projectInBar(page)).toHaveAttribute('data-project', a.id);
    await expect(list()).toHaveAttribute('aria-busy', 'false');
    await list().locator('.ca-card').filter({ hasText: '甲人物' }).click(); await nav('分镜设计');
    const delayed = await holdResponse(url => url.pathname === '/api/project-assets/assets/' + ca.id);
    await nav('项目资产'); await delayed.captured;
    await work().getByLabel('基础信息', { exact: true }).fill('重新进入后已经保存的新资料');
    await work().getByRole('button', { name: '保存资料', exact: true }).click();
    await expect(work().getByRole('button', { name: '保存资料', exact: true })).toBeDisabled();
    await expect.poll(async () => (await api('/project-assets/assets/' + ca.id)).base_info).toBe('重新进入后已经保存的新资料');
    await delayed.release();
    await expect(work().getByLabel('基础信息', { exact: true })).toHaveValue('重新进入后已经保存的新资料');
    await expect(work().getByRole('alert')).toHaveCount(0);
    await page.screenshot({ path: path.join(evidence, 'project-assets.png'), fullPage: true });
  });
  await check('公共人物复制后项目、列表和详情一致，归档/恢复后重新读取', async () => {
    await showPublicAssets(page); await settled(['公共人物']); await list().locator('.ca-card').click();
    await work().getByRole('button', { name: '复制到项目', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '复制人物' });
    await dialog.getByLabel('目标项目').selectOption(b.id); await dialog.getByLabel('复制后人物名称').fill('公共人物乙');
    await dialog.getByRole('button', { name: '确认复制', exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(projectInBar(page)).toHaveAttribute('data-project', b.id); await settled(['公共人物乙', '乙人物']);
    await expect(work().getByRole('heading', { name: '公共人物乙', exact: true })).toBeVisible();
    await work().getByRole('button', { name: '归档', exact: true }).click();
    await expect(work().getByRole('button', { name: '恢复', exact: true })).toBeVisible(); await settled(['乙人物']);
    await expect(work().getByLabel('人物名称')).toBeDisabled();
    await work().getByRole('button', { name: '恢复', exact: true }).click(); await settled(['公共人物乙', '乙人物']);
    await expect(work().getByLabel('人物名称')).toBeEnabled(); await expect(work().getByRole('alert')).toHaveCount(0);
  });
  assert.deepEqual(errors, []); assert.deepEqual(external, []); passed = true;
} catch (e) {
  await page?.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(evidence, 'failure.txt'), e.stack); throw e;
} finally {
  for (const release of held) release.resolve();
  await context?.unrouteAll({ behavior: 'wait' }); await browser?.close();
  if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
  let timer; try { await Promise.race([exited, new Promise((_, reject) => timer = setTimeout(() => reject(Error('Owned application shutdown unknown')), 15000))]); } finally { clearTimeout(timer); }
  const closed = logs.includes('APPLICATION_CLOSED_KNOWN');
  await fs.writeFile(path.join(evidence, 'server.log'), logs);
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify({ passed, checks, errors, external, dist, resources: { browserClosed: !browser?.isConnected(), applicationClosedKnown: closed, tempRemoved: passed && closed, ...(!passed ? { retained: temp } : {}) } }, null, 2));
  if (passed && closed) await fs.rm(temp, { recursive: true, force: true });
  assert.ok(closed, 'APPLICATION_CLOSED_KNOWN');
}
