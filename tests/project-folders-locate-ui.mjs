// 项目页跟着顶栏走（方案 A）：进入项目页、或顶栏换了当前项目时，打开当前项目所在的那一层并高亮它；
// 在页里手动换目录不被拉回；在当前层里点卡片换当前项目不跳。真实本地服务 + 合成剧集。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-folder-locate-'));
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal'), CODEX_HOME: path.join(temp, 'no-codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_CODEX_AUTOCONNECT: '0', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); if (!response.ok) throw Object.assign(Error(data.error || response.status), { data }); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const rid = () => crypto.randomUUID();
const pf = () => page.locator('.pf');
const title = () => pf().getByRole('heading', { level: 1 });
const crumbs = () => pf().getByRole('navigation', { name: '位置' });
const cardOf = id => pf().locator('.pf-card.pf-episode').filter({ has: page.locator(`[data-project-id="${id}"]`) });
const epButton = re => pf().getByRole('button', { name: re });
/** 用层级栏第一段的搜索切到指定项目（「穿越 1 2」= 第 1 季第 2 集），按项目 ID 点选。 */
async function goTo(id, query) {
  const bar = page.locator('.ppb').first(); await bar.getByRole('navigation', { name: '当前项目' }).getByRole('button').first().click();
  await bar.locator('.ppb-search input').fill(query); await bar.locator(`.ppb-option[data-target-project="${id}"]`).first().click();
  await expect(bar).toHaveAttribute('data-project', id);
}
const nav = name => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click();

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  const s = await api('/project-series', { name: '穿越计', software: 'jianying', request_id: rid() });
  const q = await api(`/project-series/${s.id}/seasons`, { request_id: rid() });
  const season = []; for (let i = 1; i <= 2; i++) season.push((await api(`/project-series/${s.id}/episodes`, { season_id: q.id, expected_episode_no: i, request_id: rid() })).project);
  const direct = (await api(`/project-series/${s.id}/episodes`, { season_id: null, expected_episode_no: 1, request_id: rid() })).project;
  const solo = await api('/projects', { name: '独立短片' });
  const other = await api('/project-series', { name: '另一部', software: 'jianying', request_id: rid() });
  // 一季 32 集：小窗口里后面的集在屏外
  const long = await api('/project-series', { name: '长剧', software: 'jianying', request_id: rid() });
  const lq = await api(`/project-series/${long.id}/seasons`, { request_id: rid() });
  const longEps = []; for (let i = 1; i <= 32; i++) longEps.push((await api(`/project-series/${long.id}/episodes`, { season_id: lq.id, expected_episode_no: i, request_id: rid() })).project);

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => { try { localStorage.setItem('shiguang.refreshSeconds', '0'); } catch {} });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/#/all'); await expect(page.locator('.ppb').first()).toHaveAttribute('data-project', /./);

  await check('从别的页面进入项目页：当前是季里的集 → 直接打开那一季，当前集高亮并在视野里', async () => {
    await goTo(season[1].id, '穿越 1 2'); await nav('项目');
    await expect(title()).toHaveText('第 1 季'); await expect(crumbs()).toContainText('穿越计');
    const current = epButton(/第 2 集（当前项目）$/); await expect(current).toBeVisible(); await expect(current).toBeInViewport();
    await expect(pf().locator('.pf-card[data-current][data-flash]')).toHaveCount(1); // 进来时闪一下
  });

  await check('在项目页里用顶栏换项目：直接放在剧里的集 → 打开剧；未分组项目 → 最外层', async () => {
    await goTo(direct.id, '穿越计'); await expect(title()).toHaveText('穿越计');
    await expect(epButton(/（当前项目）$/)).toBeVisible();
    await goTo(solo.id, '独立'); await expect(title()).toHaveText('项目');
    await expect(epButton(/^独立短片（当前项目）$/)).toBeVisible();
  });

  await check('在项目页里手动进别的剧：不会被拉回当前项目那一层', async () => {
    await pf().getByRole('button', { name: '打开剧 另一部' }).click(); await expect(title()).toHaveText('另一部');
    await page.waitForTimeout(1200); await expect(title()).toHaveText('另一部');
  });

  await check('离开再回来：又回到当前项目那一层', async () => {
    await nav('全部素材'); await expect(pf()).toHaveCount(0); await nav('项目');
    await expect(title()).toHaveText('项目'); await expect(epButton(/^独立短片（当前项目）$/)).toBeVisible();
  });

  await check('在当前层里点另一张卡片换当前项目：不跳层、不闪', async () => {
    await goTo(season[0].id, '穿越 1 1'); await expect(title()).toHaveText('第 1 季');
    await page.waitForTimeout(1500); // 等进入时的高亮结束
    await epButton(/第 2 集$/).click(); await expect(epButton(/第 2 集（当前项目）$/)).toBeVisible();
    await expect(title()).toHaveText('第 1 季'); await expect(pf().locator('.pf-card[data-flash]')).toHaveCount(0);
  });

  await check('反例：顶栏切到同一层里屏外的集 → 不跳层，但滚到它并闪一下；本页点卡片仍不闪', async () => {
    await page.setViewportSize({ width: 1100, height: 600 });
    await goTo(longEps[0].id, '长剧 1 1'); await expect(title()).toHaveText('第 1 季'); await expect(crumbs()).toContainText('长剧');
    const last = epButton(/^长剧 第 1 季 第 32 集/); await expect(last).not.toBeInViewport();
    await page.waitForTimeout(1500); // 等进入时的高亮结束
    await goTo(longEps[31].id, '长剧 1 32'); await expect(title()).toHaveText('第 1 季');
    await expect(epButton(/^长剧 第 1 季 第 32 集（当前项目）$/)).toBeInViewport({ timeout: 2500 });
    await expect(pf().locator('.pf-card[data-current][data-flash]')).toHaveCount(1);
    await page.waitForTimeout(1500);
    await epButton(/^长剧 第 1 季 第 31 集$/).click(); await expect(epButton(/^长剧 第 1 季 第 31 集（当前项目）$/)).toBeVisible();
    await expect(pf().locator('.pf-card[data-flash]')).toHaveCount(0); await expect(title()).toHaveText('第 1 季');
  });

  if (errors.length) throw Error('页面不应出现脚本错误：' + errors.join(' / '));
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-2500)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'folder-locate-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); let timer; if (await Promise.race([exited, new Promise(r => timer = setTimeout(() => r('timeout'), 10000))]) === 'timeout') { child.kill('SIGKILL'); await exited; } clearTimeout(timer);
  await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
