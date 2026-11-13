// 项目资产（人物 / 场景）和生成视频在项目为空时的样子。真实本地服务 + 空的合成项目；不接入真实素材库。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { selectProjectInBar } from './helpers/path-bar.mjs';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-empty-states-'));
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal_item'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); assert.ok(response.ok, p + ' ' + JSON.stringify(data)); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const shot = async name => { if (process.env.EMPTY_SHOTS) await page.screenshot({ path: path.join(process.env.EMPTY_SHOTS, name + '.png') }); };
const assets = () => page.getByRole('region', { name: '项目资产库' });
const videos = () => page.getByRole('region', { name: '项目生成视频' });
const addCard = () => assets().locator('.ca-card-add');

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  const project = await api('/projects', { name: '空项目' });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/#/project-assets'); await expect(assets()).toBeVisible(); await selectProjectInBar(page, project.id);

  await check('人物为空：新建卡是白底实线，写「还没有人物 / 拖入图片或点击新建」；不显示筛选和计数', async () => {
    await expect(addCard()).toContainText('还没有人物'); await expect(addCard()).toContainText('拖入图片或点击新建');
    await expect(assets().getByRole('group', { name: '筛选' })).toHaveCount(0); await expect(assets().locator('.ca-count')).toHaveCount(0);
    const style = await addCard().evaluate(el => { const s = getComputedStyle(el); return { border: s.borderTopStyle, bg: s.backgroundColor, h: el.getBoundingClientRect().height, w: el.getBoundingClientRect().width }; });
    assert.equal(style.border, 'solid'); assert.notEqual(style.bg, 'rgba(0, 0, 0, 0)', 'white, not transparent'); assert.ok(style.h > style.w * 1.5, 'as tall as a portrait card');
    await shot('people-empty');
  });

  await check('场景为空同样处理；搜不到结果不算「还没有」，筛选与计数照常显示', async () => {
    await assets().getByRole('tab', { name: '场景', exact: true }).click();
    await expect(addCard()).toContainText('还没有场景'); await expect(assets().getByRole('group', { name: '筛选' })).toHaveCount(0);
    await assets().getByRole('tab', { name: '人物', exact: true }).click(); await expect(addCard()).toContainText('还没有人物');
    await assets().getByLabel('搜索资产').fill('不存在的名字');
    await expect(addCard()).toHaveText('新建人物'); await expect(assets().getByRole('group', { name: '筛选' })).toBeVisible();
    await assets().getByLabel('搜索资产').fill(''); await expect(addCard()).toContainText('还没有人物');
  });

  await check('FE1-R1 反例：资产列表读取 503 时不显示「还没有人物」、不收筛选；关掉错误后仍不显示；重读成功确认零条后才显示', async () => {
    let fail = 1;
    await page.route(url => url.pathname === '/api/project-assets/assets', route => { if (route.request().method() === 'GET' && fail > 0) { fail--; return route.fulfill({ status: 503, json: { error: '服务暂时不可用' } }); } return route.fallback(); });
    await page.reload(); await expect(assets()).toBeVisible(); await selectProjectInBar(page, project.id);
    const alert = assets().getByRole('alert'); await expect(alert).toContainText('服务暂时不可用');
    await expect(addCard()).toHaveText('新建人物'); await expect(assets().getByRole('group', { name: '筛选' })).toBeVisible();
    await alert.getByRole('button', { name: '关闭错误' }).click(); await expect(alert).toHaveCount(0);
    await page.waitForTimeout(300); await expect(addCard()).toHaveText('新建人物'); await expect(assets().getByRole('group', { name: '筛选' })).toBeVisible();
    await assets().getByRole('tab', { name: '场景', exact: true }).click(); await assets().getByRole('tab', { name: '人物', exact: true }).click();
    await expect(addCard()).toContainText('还没有人物'); await expect(assets().getByRole('group', { name: '筛选' })).toHaveCount(0);
    assert.equal(fail, 0); await page.unroute(url => url.pathname === '/api/project-assets/assets');
  });

  await check('有了第一个人物：筛选和计数回来，新建卡只写「新建人物」', async () => {
    await api('/project-assets/assets', { project_id: project.id, kind: 'character', name: '阿青' });
    await page.reload(); await expect(assets()).toBeVisible(); await selectProjectInBar(page, project.id);
    await expect(assets().locator('.ca-card-wrap')).toHaveCount(1);
    await expect(addCard()).toHaveText('新建人物'); await expect(assets().getByRole('group', { name: '筛选' })).toBeVisible(); await expect(assets().locator('.ca-count')).toContainText('1 个人物');
    assert.equal(await addCard().evaluate(el => getComputedStyle(el).borderTopStyle), 'solid');
    await shot('people-one');
  });

  await check('FE2-R3 反例：已有 1 个人物 → 场景请求挂起 → 立即回人物且人物请求挂起：显示加载、不报「还没有」、筛选保留 → 放行后人物恢复', async () => {
    const hold = { scene: false, character: false }, release = {};
    const handler = async route => {
      const kind = new URL(route.request().url()).searchParams.get('kind');
      if (route.request().method() === 'GET' && hold[kind]) await new Promise(r => { release[kind] = r; });
      return route.fallback();
    };
    await page.route(url => url.pathname === '/api/project-assets/assets', handler);
    await expect(assets().locator('.ca-card-wrap')).toHaveCount(1);
    hold.scene = true; await assets().getByRole('tab', { name: '场景', exact: true }).click(); await expect.poll(() => !!release.scene).toBe(true);
    hold.character = true; await assets().getByRole('tab', { name: '人物', exact: true }).click(); await expect.poll(() => !!release.character).toBe(true);
    await expect(assets().getByText('正在加载当前项目的人物…')).toBeVisible();
    await expect(addCard()).not.toContainText('还没有'); await expect(assets().getByRole('group', { name: '筛选' })).toBeVisible();
    release.scene(); release.character();
    await expect(assets().locator('.ca-card-wrap')).toHaveCount(1); await expect(addCard()).toHaveText('新建人物');
    await page.unroute(url => url.pathname === '/api/project-assets/assets', handler);
  });

  await check('生成视频·项目为空：收起搜索、采用筛选和「0 / 0 个视频」；网格里一张「还没有生成视频」卡，点它打开导入', async () => {
    await page.goto(origin + '/#/project-videos'); await expect(videos()).toBeVisible(); await selectProjectInBar(page, project.id);
    const card = videos().locator('.pv-card-empty'); await expect(card).toContainText('还没有生成视频'); await expect(card).toContainText('拖入视频或点击导入');
    await expect(videos().getByLabel('搜索视频')).toHaveCount(0); await expect(videos().getByRole('group', { name: '按采用状态筛选' })).toHaveCount(0);
    await expect(videos().locator('.pv-library-head')).toHaveCount(0); await expect(videos().locator('.pv-empty')).toHaveCount(0);
    await expect(videos().getByRole('button', { name: '导入视频' }).first()).toBeVisible(); await expect(videos().getByRole('navigation', { name: /视频文件夹/ })).toBeVisible();
    await shot('videos-empty');
    await card.click(); await expect(page.getByRole('dialog', { name: '导入视频' })).toBeVisible();
  });

  await check('FE1-R2 反例：根目录为空但项目还有 1 个待升级旧视频：不显示「还没有生成视频」，搜索、筛选和原提示都保留', async () => {
    await page.route(url => /\/api\/project-videos\/projects\/[^/]+$/.test(url.pathname), async route => {
      const res = await route.fetch(), data = await res.json();
      if (res.ok()) data.legacyUpgrade = { count: 1, completed: false };
      await route.fulfill({ response: res, json: data });
    });
    await page.goto(origin + '/#/project-videos'); await page.reload(); await expect(videos()).toBeVisible(); await selectProjectInBar(page, project.id);
    await expect(videos().locator('.pv-empty')).toContainText('当前目录还没有视频');
    await expect(videos().locator('.pv-card-empty')).toHaveCount(0);
    await expect(videos().getByLabel('搜索视频')).toBeVisible(); await expect(videos().getByRole('group', { name: '按采用状态筛选' })).toBeVisible(); await expect(videos().locator('.pv-library-head')).toBeVisible();
  });

  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-3000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'creative-empty-states-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); await exited; await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
