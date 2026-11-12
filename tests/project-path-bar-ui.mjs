// 顶部层级栏（ProjectPathBar，SERIES-P1 H1–H3）：真实本地服务 + 合成剧集；不接入真实素材库。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-pathbar-'));
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal'), CODEX_HOME: path.join(temp, 'no-codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_CODEX_AUTOCONNECT: '0', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); assert.ok(response.ok, p + ' ' + JSON.stringify(data)); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const rid = () => crypto.randomUUID();
const bar = () => page.locator('.ppb');
const crumbs = () => bar().getByRole('navigation', { name: '当前项目' });
const seg = name => crumbs().getByRole('button', { name, exact: true });
const pop = () => bar().getByRole('dialog');
const options = () => pop().getByRole('option');
const ledgerTitle = () => page.getByRole('region', { name: '项目素材篮' }).locator('.project-title h2');
const pick = async (segment, query) => { await seg(segment).click(); await expect(pop()).toBeVisible(); if (query != null) await pop().getByRole('combobox').fill(query); };

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  const s = await api('/project-series', { name: '穿越计', software: 'jianying', request_id: rid() });
  const s1 = await api(`/project-series/${s.id}/seasons`, { request_id: rid() }), s2 = await api(`/project-series/${s.id}/seasons`, { request_id: rid() });
  await api(`/project-series/${s.id}/seasons`, { request_id: rid() });
  for (let i = 1; i <= 3; i++) await api(`/project-series/${s.id}/episodes`, { season_id: s1.id, expected_episode_no: i, request_id: rid() });
  for (let i = 1; i <= 2; i++) await api(`/project-series/${s.id}/episodes`, { season_id: s2.id, expected_episode_no: i, request_id: rid() });
  await api(`/project-series/${s.id}/episodes`, { season_id: null, expected_episode_no: 1, request_id: rid() });
  await api('/projects', { name: '独立片' });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1480, height: 1000 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/#/project-usage'); await expect(bar()).toBeVisible();

  await check('全局搜索「穿越 1 2」只命中第 1 季第 2 集；回车后层级栏三段、素材使用切到这一集', async () => {
    await crumbs().getByRole('button').first().click(); await expect(pop()).toBeVisible(); await pop().getByRole('combobox').fill('穿越 1 2');
    await expect(options()).toHaveCount(1); await expect(options().first()).toContainText('穿越计 › 第 1 季 › 第2集');
    await page.keyboard.press('Enter'); await expect(pop()).toHaveCount(0);
    await expect(seg('穿越计')).toBeVisible(); await expect(seg('第 1 季')).toBeVisible(); await expect(seg('第2集')).toBeVisible();
    await expect(ledgerTitle()).toHaveText('穿越计 第1季 第2集');
  });

  await check('上一集 / 下一集只在本季内：到第 3 集后「下一集」变灰，不跨到第 2 季', async () => {
    await bar().getByRole('button', { name: '下一集：第3集' }).click(); await expect(seg('第3集')).toBeVisible(); await expect(ledgerTitle()).toHaveText('穿越计 第1季 第3集');
    await expect(bar().getByRole('button', { name: '已是这一组的最后一集' })).toBeDisabled();
  });

  await check('集这一段只列本季 3 集；输入 1 后回车打开第 1 集，上一集变灰', async () => {
    await pick('第3集'); await expect(pop().getByText('第 1 季 · 3 集')).toBeVisible(); await expect(options()).toHaveCount(3);
    await pop().getByRole('combobox').fill('1'); await expect(options().first()).toContainText('第 1 集'); await page.keyboard.press('Enter');
    await expect(seg('第1集')).toBeVisible(); await expect(bar().getByRole('button', { name: '已是这一组的第一集' })).toBeDisabled();
  });

  await check('季这一段：空的第 3 季显示「暂无集」不可选；选第 2 季落到编号最小的第 1 集', async () => {
    await pick('第 1 季'); await expect(options()).toHaveCount(4);
    const empty = options().filter({ hasText: '第 3 季' }); await expect(empty).toContainText('暂无集'); await expect(empty).toHaveAttribute('aria-disabled', 'true');
    await options().filter({ hasText: '第 2 季' }).click(); await expect(seg('第 2 季')).toBeVisible(); await expect(seg('第1集')).toBeVisible();
    await expect(ledgerTitle()).toHaveText('穿越计 第2季 第1集');
  });

  await check('只输「1」列出三个第 1 集（两季 + 剧里），选剧里的：中间段显示「剧里」；从「剧里」能回到第 1 季上次看的第 1 集', async () => {
    await pick('穿越计', '1'); await expect(options()).toHaveCount(3);
    await options().filter({ hasText: /^穿越计 › 第1集/ }).click();
    await expect(seg('剧里')).toBeVisible(); await expect(ledgerTitle()).toHaveText('穿越计 第1集');
    await pick('剧里'); await options().filter({ hasText: '第 1 季' }).click();
    await expect(seg('第 1 季')).toBeVisible(); await expect(seg('第1集')).toBeVisible(); await expect(ledgerTitle()).toHaveText('穿越计 第1季 第1集');
  });

  await check('剧这一段：有「最近打开」；选未分组的独立片后只剩一段、没有上一集 / 下一集；Esc 关闭并回到按钮', async () => {
    await pick('穿越计'); await expect(pop().getByText('最近打开')).toBeVisible();
    await expect(pop().getByText('未分组')).toBeVisible(); await options().filter({ hasText: '独立片' }).click();
    await expect(seg('独立片')).toBeVisible(); await expect(crumbs().getByRole('button')).toHaveCount(1);
    await expect(bar().getByRole('button', { name: /上一集|第一集/ })).toHaveCount(0);
    await seg('独立片').click(); await expect(pop()).toBeVisible(); await page.keyboard.press('Escape'); await expect(pop()).toHaveCount(0);
    await expect(seg('独立片')).toBeFocused();
  });

  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-3000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'creative-pathbar-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); await exited; await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
