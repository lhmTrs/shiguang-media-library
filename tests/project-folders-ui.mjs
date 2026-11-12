// 目录式项目页（SERIES-P1）：真实本地服务 + 空的合成库；不接入真实素材库。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-folders-'));
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, passed = false; const checks = [], errors = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal'), CODEX_HOME: path.join(temp, 'no-codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_CODEX_AUTOCONNECT: '0', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const pf = () => page.locator('.pf');
const heading = name => pf().getByRole('heading', { level: 1, name, exact: true });
const card = name => pf().getByRole('button', { name: new RegExp('^' + name.replace(/[()（）]/g, '.') + '(（当前项目）)?$') });
const menu = () => page.getByRole('menu', { name: '操作' });
const toast = () => page.locator('.pf-toast');
const rightClick = async name => { await card(name).click({ button: 'right' }); await expect(menu()).toBeVisible(); };
let delaySeries = false, holdSeries = false, releaseSeries = null, cookie, token;
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); assert.ok(response.ok, p + ' ' + JSON.stringify(data)); return data; }

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1480, height: 1000 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  await page.route(url => url.pathname === '/api/project-series', async route => {
    if (route.request().method() === 'GET' && delaySeries) await new Promise(r => setTimeout(r, 400));
    if (route.request().method() === 'GET' && holdSeries) await new Promise(r => { const prev = releaseSeries; releaseSeries = () => { prev?.(); r(); }; });
    return route.fallback();
  });
  await page.goto(origin + '/#/projects'); await expect(pf()).toBeVisible();

  await check('空库：显示新建剧 / 新建项目 / 从 XML 导入', async () => {
    for (const name of ['新建剧', '新建项目', '从达芬奇 XML 导入']) await expect(pf().locator('.project-blank').getByRole('button', { name, exact: true })).toBeVisible();
  });

  await check('FE-R1 反例：新建剧后剧列表延迟 400ms 才返回，仍直接进入新剧，不退回根目录；刷新页面停在原位置', async () => {
    delaySeries = true;
    await pf().locator('.project-blank').getByRole('button', { name: '新建剧' }).click();
    const d = page.getByRole('dialog', { name: '新建剧' }); await d.getByLabel('剧名').fill('穿越计'); await d.getByLabel('剧的剪辑软件').selectOption('jianying'); await d.getByRole('button', { name: '新建剧', exact: true }).click();
    await expect(heading('穿越计')).toBeVisible(); await page.waitForTimeout(900); await expect(heading('穿越计')).toBeVisible();
    await expect(pf().getByRole('navigation', { name: '位置' })).toContainText('穿越计');
    delaySeries = false;
    await page.reload(); await expect(heading('穿越计')).toBeVisible();
  });

  await check('剧里一次点击新建季、新建剧里的第 1、2 集；当前集卡给出素材使用等入口和分享给 Agent', async () => {
    await pf().getByRole('button', { name: '新建季', exact: true }).click(); await expect(card('打开 第 1 季')).toBeVisible();
    await pf().getByRole('button', { name: '新建第 1 集（剧里）' }).click(); await expect(card('穿越计 第 1 集')).toBeVisible();
    await pf().getByRole('button', { name: '新建第 2 集（剧里）' }).click(); await expect(card('穿越计 第 2 集')).toBeVisible();
    const links = pf().getByRole('navigation', { name: '第 2 集的快捷入口' });
    for (const name of ['素材使用', '项目资产', '生成视频', '分镜']) await expect(links.getByRole('button', { name, exact: true })).toBeVisible();
    await expect(links.getByRole('button', { name: /分享给 Agent/ })).toBeVisible();
    await expect(toast()).toContainText('已新建「穿越计 第2集」');
  });

  await check('进入第 1 季新建它的第 1 集；面包屑回到剧', async () => {
    await card('打开 第 1 季').dblclick(); await expect(heading('第 1 季')).toBeVisible();
    await pf().getByRole('button', { name: '新建第 1 集（第 1 季）' }).click(); await expect(card('穿越计 第 1 季 第 1 集')).toBeVisible();
    await pf().getByRole('navigation', { name: '位置' }).getByRole('button', { name: '穿越计' }).click(); await expect(heading('穿越计')).toBeVisible();
  });

  await check('⌘A 选中剧里两集拖进第 1 季：第 1 集撞号，整批不动、给改号清单；改成 5 后移动成功；撤销后回到剧里', async () => {
    await card('穿越计 第 1 集').click(); await page.keyboard.press('Meta+a');
    await expect(pf().getByRole('heading', { name: /已选 2 集/ })).toBeVisible();
    await card('穿越计 第 1 集').dragTo(card('打开 第 1 季'));
    const d = page.getByRole('dialog', { name: '集号冲突，改号后再提交' }); await expect(d).toBeVisible(); await expect(d).toContainText('第 1 集已被占用');
    await expect(card('穿越计 第 1 集')).toBeVisible(); await expect(card('穿越计 第 2 集')).toBeVisible();
    await d.getByLabel('穿越计 第1集的集号').fill('5'); await d.getByRole('button', { name: '移动 2 集' }).click();
    await expect(toast()).toContainText('已把 2 集移到「穿越计 第 1 季」'); await expect(card('穿越计 第 1 集')).toHaveCount(0);
    await expect(card('打开 第 1 季')).toContainText('3 集');
    await toast().getByRole('button', { name: '撤销' }).click(); await expect(toast()).toContainText('已撤销这次移动');
    await expect(card('穿越计 第 1 集')).toBeVisible(); await expect(card('穿越计 第 2 集')).toBeVisible(); await expect(card('打开 第 1 季')).toContainText('1 集');
  });

  await check('右键第 2 集「往前移」：和第 1 集交换号码，原来的第 2 集卡片用小字显示项目原名；第 1 集的「往前移」不可点', async () => {
    await rightClick('穿越计 第 2 集'); await menu().getByRole('menuitem', { name: /^往前移/ }).click();
    await expect(toast()).toContainText('已交换第 1、2 集');
    await expect(card('穿越计 第 1 集')).toContainText('穿越计 第2集');
    await rightClick('穿越计 第 1 集'); await expect(menu().getByRole('menuitem', { name: /^往前移/ })).toBeDisabled(); await page.keyboard.press('Escape'); await page.mouse.click(5, 5);
  });

  await check('季改名为「第一季」；有集的季不能删', async () => {
    await rightClick('打开 第 1 季'); await expect(menu().getByRole('menuitem', { name: '删除空季' })).toBeDisabled();
    await menu().getByRole('menuitem', { name: '改名 / 改季号…' }).click();
    const d = page.getByRole('dialog', { name: '改名 / 改季号' }); await d.getByLabel('季的显示名').fill('第一季'); await d.getByRole('button', { name: '保存' }).click();
    await expect(card('打开 第一季')).toBeVisible();
  });

  await check('根目录新建未分组项目，右键「放进剧…」放到穿越计剧里：先填号（默认第 3 集），之后出现在剧里', async () => {
    await pf().getByRole('navigation', { name: '位置' }).getByRole('button', { name: '项目' }).click(); await expect(heading('项目')).toBeVisible();
    await pf().getByRole('button', { name: '新建项目', exact: true }).click();
    const e = page.getByRole('dialog', { name: '新建项目' }); await e.getByLabel('项目名称').fill('番外合集'); await e.getByRole('button', { name: '保存项目' }).click();
    await expect(card('番外合集')).toBeVisible();
    await rightClick('番外合集'); await menu().getByRole('menuitem', { name: '放进剧…' }).click();
    const m = page.getByRole('dialog', { name: '移到…' }); await m.getByLabel('目标位置').selectOption({ label: '穿越计（剧里，不进季）' }); await m.getByRole('button', { name: '移动' }).click();
    const n = page.getByRole('dialog', { name: '确认集号' }); await expect(n.getByLabel('番外合集的集号')).toHaveValue('3'); await n.getByRole('button', { name: '保存' }).click();
    await expect(toast()).toContainText('已把 1 集移到「穿越计」'); await expect(card('番外合集')).toHaveCount(0);
    await expect(card('打开剧 穿越计')).toContainText('4 集');
  });

  await check('剧里点第 3 集的「素材使用」：跳到素材使用页并打开这一集', async () => {
    await card('打开剧 穿越计').dblclick(); await expect(heading('穿越计')).toBeVisible();
    await card('穿越计 第 3 集').click();
    await pf().getByRole('navigation', { name: '第 3 集的快捷入口' }).getByRole('button', { name: '素材使用' }).click();
    await expect(page).toHaveURL(/#\/project-usage/); await expect(page.getByRole('region', { name: '项目素材篮' }).getByRole('heading', { name: '番外合集', exact: true })).toBeVisible();
  });

  await check('FE-R2 反例：新建剧后剧列表请求挂起 → 切到「全部素材」再切回「项目」→ 放行请求：仍在新剧里，不用再双击', async () => {
    await page.goto(origin + '/#/projects'); await pf().getByRole('navigation', { name: '位置' }).getByRole('button', { name: '项目' }).click().catch(() => {});
    await expect(heading('项目')).toBeVisible();
    holdSeries = true; releaseSeries = null;
    await pf().getByRole('button', { name: '新建剧', exact: true }).click();
    const d = page.getByRole('dialog', { name: '新建剧' }); await d.getByLabel('剧名').fill('续集'); await d.getByRole('button', { name: '新建剧', exact: true }).click();
    await expect(d).toHaveCount(0);
    // 目录位置按素材库分键存（shiguang.projectFolders.loc:<库 ID>）。
    const saved = await page.evaluate(() => { const k = Object.keys(sessionStorage).find(x => x.startsWith('shiguang.projectFolders.loc:')); return k ? JSON.parse(sessionStorage.getItem(k)) : null; });
    assert.equal(saved.level, 'series');
    await page.goto(origin + '/#/all'); await expect(pf()).toHaveCount(0);
    await page.goto(origin + '/#/projects'); await expect(heading('续集')).toBeVisible();
    holdSeries = false; releaseSeries?.(); releaseSeries = null;
    await page.waitForTimeout(600); await expect(heading('续集')).toBeVisible();
    await expect(pf().getByRole('navigation', { name: '位置' })).toContainText('续集');
  });

  await check('真正被删除的剧仍回退：停在「续集」时它在别处被删，刷新后回到根目录', async () => {
    const list = await api('/project-series'), target = list.find(x => x.name === '续集');
    await api(`/project-series/${target.id}`, { expected_revision: target.revision }, 'DELETE');
    await page.reload(); await expect(heading('项目')).toBeVisible(); await expect(card('打开剧 续集')).toHaveCount(0);
  });

  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-3000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'creative-folders-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); await exited; await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
