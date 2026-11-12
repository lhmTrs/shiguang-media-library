// 素材使用页（ProjectUsage，#/project-usage）回归：从目录页集卡的「素材使用」进入。真实本地服务 + 合成图片库；不接入真实素材库。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-usage-')), images = path.join(temp, '合成照片'); await fs.mkdir(images);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMw7kj7DwAENAIhJ+yrnwAAAABJRU5ErkJggg==', 'base64');
for (let i = 1; i <= 3; i++) await fs.writeFile(path.join(images, '合成图片' + i + '.png'), png);
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal'), CODEX_HOME: path.join(temp, 'no-codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_READONLY_FILES: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); assert.ok(response.ok, p + ' ' + JSON.stringify(data)); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const ledger = () => page.getByRole('region', { name: '项目素材篮' });
const rows = () => ledger().locator('.project-item');
const folders = () => page.locator('.pf');
const openProject = async name => {
  await page.goto(origin + '/#/projects'); await expect(folders()).toBeVisible();
  await folders().getByRole('button', { name: new RegExp('^' + name) }).first().dblclick();
  await expect(page).toHaveURL(/#\/project-usage/); await expect(ledger().getByRole('heading', { name, exact: true })).toBeVisible();
};

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  await api('/roots', { path: images, kind: 'photo' });
  await expect.poll(async () => (await api('/jobs')).jobs.every(j => j.status !== 'running'), { timeout: 20000 }).toBe(true);
  const assets = (await api('/assets?' + new URLSearchParams({ q: '合成图片' }))).items ?? (await api('/assets')).items;
  const byName = n => assets.find(a => a.name.startsWith(n)).id;
  const a = await api('/projects', { name: '甲项目' }), b = await api('/projects', { name: '乙项目' });
  await api(`/projects/${a.id}/items`, { ids: [byName('合成图片1'), byName('合成图片2')] });
  await api(`/projects/${b.id}/items`, { ids: [byName('合成图片3')] });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1480, height: 1000 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  await page.goto(origin + '/#/projects'); await expect(page.locator('.pf')).toBeVisible();

  await check('从目录的集卡进入甲的素材使用：候选 2 条、照片筛选计数 2、标题区有导入 / 添加 / 分享给 Agent', async () => {
    await openProject('甲项目');
    await expect(rows()).toHaveCount(2); await expect(ledger().getByRole('tab', { name: /^候选素材 2/ })).toBeVisible();
    await expect(ledger().getByRole('button', { name: '筛选项目照片' })).toContainText('2');
    for (const name of ['导入达芬奇时间线', '添加素材']) await expect(ledger().getByRole('button', { name, exact: true })).toBeVisible();
    await expect(ledger().getByRole('button', { name: /分享给 Agent/ })).toBeVisible();
  });

  await check('手动标为已使用：候选变 1、已使用变 1，切到已使用能看到它', async () => {
    await ledger().getByRole('checkbox', { name: /^手动已使用：合成图片1/ }).click();
    await expect(ledger().getByRole('tab', { name: /^已使用 1/ })).toBeVisible(); await expect(ledger().getByRole('tab', { name: /^候选素材 1/ })).toBeVisible();
    await ledger().getByRole('tab', { name: /^已使用/ }).click(); await expect(rows()).toHaveCount(1); await expect(rows().first()).toContainText('合成图片1');
    await ledger().getByRole('tab', { name: /^候选素材/ }).click(); await expect(rows()).toHaveCount(1);
  });

  await check('备注可保存；搜索只留匹配项；换到乙项目时搜索和筛选清空、只显示乙的素材', async () => {
    await ledger().getByRole('button', { name: '添加使用位置备注' }).click(); await ledger().getByLabel('使用位置备注').fill('第 3 场开头'); await ledger().getByRole('button', { name: '保存备注' }).click();
    await expect(ledger().getByRole('button', { name: '第 3 场开头' })).toBeVisible();
    await ledger().getByRole('button', { name: '筛选项目照片' }).click();
    await ledger().getByLabel('搜索项目素材').fill('不存在'); await expect(ledger().getByText('没有匹配的项目素材')).toBeVisible();
    await openProject('乙项目');
    await expect(ledger().getByLabel('搜索项目素材')).toHaveValue(''); await expect(ledger().getByRole('button', { name: '筛选项目全部' })).toHaveAttribute('aria-pressed', 'true');
    await expect(rows()).toHaveCount(1); await expect(rows().first()).toContainText('合成图片3');
  });

  await check('导入达芬奇时间线：打开导入框、可关闭；从项目移出素材后计数随之变化', async () => {
    await ledger().getByRole('button', { name: '导入达芬奇时间线', exact: true }).click();
    await expect(page.getByRole('button', { name: '关闭时间线导入' })).toBeVisible(); await page.getByRole('button', { name: '关闭时间线导入' }).click();
    await expect(page.getByRole('button', { name: '关闭时间线导入' })).toHaveCount(0);
    await ledger().getByRole('button', { name: /^移出项目素材：合成图片3/ }).click();
    await expect(rows()).toHaveCount(0); await expect(ledger().getByRole('tab', { name: /^候选素材 0/ })).toBeVisible();
  });

  await check('编辑项目移到目录：右键乙项目卡片「改名」，保存后卡片和素材使用标题都用新名字', async () => {
    await page.goto(origin + '/#/projects'); await expect(folders()).toBeVisible();
    await folders().getByRole('button', { name: /^乙项目/ }).first().click({ button: 'right' });
    await page.getByRole('menu', { name: '操作' }).getByRole('menuitem', { name: '改名' }).click();
    const editor = page.getByRole('dialog', { name: '编辑项目' }); await editor.getByLabel('项目名称').fill('乙项目改名'); await editor.getByRole('button', { name: '保存项目' }).click();
    await expect(folders().getByRole('button', { name: /^乙项目改名/ })).toBeVisible();
    await openProject('乙项目改名');
  });

  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-3000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'creative-usage-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); await exited; await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
