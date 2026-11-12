import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { syntheticSource } from './helpers/storyboard-fixture.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = await mkdtemp(path.join(os.tmpdir(), 'project-agent-share-'));
const reserve = net.createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
assert.notEqual(port, 4317);
const origin = 'http://127.0.0.1:' + port;
const guidePath = id => '/api/projects/' + id + '/agent-guide';
const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    CONTAINER: '1',
    MEDIA_DATA_DIR: path.join(temp, 'data'),
    MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal'),
    MEDIA_SKIP_IMPORT: '1',
    MEDIA_SKIP_RECONCILE: '1',
    MEDIA_NO_WATCH: '1',
    MEDIA_CODEX_AUTOCONNECT: '0',
    MEDIA_DISABLE_DESKTOP_NATIVE: '1',
    MEDIA_CLOUD_AUDIO_ENABLED: '0',
    SHIGUANG_AUDIO_ANALYSIS: '0',
    SHIGUANG_CLOUD_RELEASE_CONFIG: path.join(temp, 'no-cloud-config.json'),
    SHIGUANG_AUDIO_RUNTIME_CONFIG: path.join(temp, 'no-audio-config.json'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '', browser, passed = false;
for (const stream of [server.stdout, server.stderr]) {
  stream.on('data', bytes => { logs = (logs + bytes).slice(-20000); });
}
const exited = new Promise(resolve => server.once('close', (code, signal) => resolve({ code, signal })));
server.on('error', error => { logs += error.message; });

function get(route, options = {}) {
  return fetch(origin + route, { signal: AbortSignal.timeout(7000), ...options });
}

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await get('/api/session');
  assert.equal(sessionResponse.status, 200);
  const { token, instanceId } = await sessionResponse.json();
  const cookie = sessionResponse.headers.get('set-cookie').split(';')[0];
  async function create(route, body) {
    const response = await get(route, {
      method: 'POST', headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  }
  const note = 'synthetic-private-project-note';
  const a = await create('/api/projects', { name: '分享项目甲', note });
  const b = await create('/api/projects', { name: '分享项目乙' });
  const board = '/api/storyboard/projects/' + b.id;
  const source = syntheticSource();
  source.title = '乙的合成分镜';
  await create(board + '/initialize', { source, expected_revision: null, request_id: randomUUID() });

  const guide = await get(guidePath(b.id));
  assert.equal(guide.status, 200);
  assert.match(guide.headers.get('content-type'), /^text\/markdown/);
  assert.equal(guide.headers.get('cache-control'), 'no-store');
  assert.equal(guide.headers.get('set-cookie'), null);
  const markdown = await guide.text();
  const binding = markdown.match(/^\x60\x60\x60json\n([\s\S]*?)\n\x60\x60\x60$/m);
  assert.deepEqual(JSON.parse(binding?.[1] ?? 'null'), { projectName: b.name, projectId: b.id, instanceId, origin });
  for (const privateValue of [a.id, source.title, token, cookie]) assert.ok(!markdown.includes(privateValue));
  assert.ok(!(await (await get(guidePath(a.id))).text()).includes(note));
  assert.equal((await get(guidePath(b.id), { headers: { origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await get(board)).status, 401);
  assert.equal((await get(board, { method: 'PUT', headers: { cookie } })).status, 403);
  assert.equal((await get(guidePath(randomUUID()))).status, 404);
  console.log('PASS 项目说明只返回当前项目接入信息，读写接口保留会话与跨站校验');

  browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 390, height: 760 } });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new DOMException('测试拒绝剪贴板', 'NotAllowedError'); } },
    });
  });
  await page.goto(origin + '/#/projects');
  const project = page.getByRole('complementary', { name: '项目列表' });
  const actions = page.locator('.project-title-actions');
  const share = scope => scope.getByRole('button', { name: '分享给 Agent', exact: true });
  const copyLink = scope => scope.getByRole('button', { name: '复制接入链接', exact: true });
  await project.getByTitle(a.name, { exact: true }).click();
  await share(actions).click();
  await copyLink(actions).click();
  await expect(actions.getByRole('textbox', { name: '接入链接' })).toHaveValue(origin + guidePath(a.id));
  await project.getByTitle(b.name, { exact: true }).click();
  await expect(copyLink(actions)).toHaveCount(0);
  await share(actions).click();
  await actions.getByRole('button', { name: '复制 Markdown 说明', exact: true }).click();
  await expect(actions.getByRole('textbox', { name: 'Markdown 说明' })).toHaveValue(markdown);
  console.log('PASS 窄屏切换项目后复制内容对应当前项目，剪贴板失败可手动复制');

  await page.goto(origin + '/#/storyboards');
  await page.getByLabel('分镜所属项目').selectOption(b.id);
  await expect(page.getByTestId('save-status')).toHaveText('已保存到数据库');
  const hideDetail = page.getByRole('button', { name: '关闭镜头详情', exact: true });
  if (await hideDetail.isVisible()) await hideDetail.click();
  await page.getByRole('button', { name: '项目设置', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '项目设置', exact: true });
  await share(settings).click();
  await copyLink(settings).click();
  await expect(settings.getByRole('textbox', { name: '接入链接' })).toHaveValue(origin + guidePath(b.id));
  await page.keyboard.press('Escape');
  await expect(settings).toBeVisible();
  await expect(share(settings)).toBeFocused();
  console.log('PASS 分镜项目设置可分享当前项目，Esc 关闭分享并回到按钮');
  passed = true;
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  if (server.pid && server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
  const actual = await Promise.race([exited, delay(12000, null, { ref: false })]);
  assert.deepEqual(actual, { code: 0, signal: null }, '隔离服务未正常退出');
  if (passed) await rm(temp, { recursive: true, force: true });
}
