// 生成视频页「升级旧视频」入口按实际待升级数显示（PV-LEGACY-UPGRADE 前端）。
// 列表的 legacyUpgrade 与升级预览按新合同（count 总是返回、completed=count===0、预览项 requiresRelink）用 page.route 模拟；
// 其余走真实的本地服务和合成视频。不触碰真实素材库。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { selectProjectInBar } from './helpers/path-bar.mjs';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-videos-legacy-'))), clips = path.join(temp, '合成视频'); await fs.mkdir(clips);
const ffmpeg = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
async function clip(name, color) {
  const file = path.join(clips, name);
  const run = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=96x64:r=8:d=2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', file]);
  assert.equal(run.status, 0, run.stderr?.toString()); return file;
}
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal_item'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) {
  const binary = Buffer.isBuffer(body);
  const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': binary ? 'application/octet-stream' : 'application/json' }, body: binary ? body : body ? JSON.stringify(body) : undefined });
  const data = await response.json(); if (!response.ok) throw Object.assign(Error(data.error || response.status), { data }); return data;
}
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
let projectId; const pv = suffix => `/project-videos/projects/${encodeURIComponent(projectId)}${suffix}`;
async function seedVideo(file, folderId) {
  const bytes = await fs.readFile(file), requestId = crypto.randomUUID();
  await api(pv('/imports'), { requestId, folderId, fileName: path.basename(file), bytes: bytes.length, prompt: { mode: 'none' } });
  const receipt = await api(pv(`/imports/${requestId}/content`), bytes, 'PUT'); assert.equal(receipt.status, 'ready'); return receipt.videoId;
}
const work = () => page.getByRole('region', { name: '项目生成视频' });
const cards = () => work().locator('.pv-card[data-video-id]');
const banner = () => work().locator('.pv-banner', { hasText: '还不是项目托管副本' });
const modal = () => page.locator('.pv-modal');
// The list's legacyUpgrade and the first video's managed flag come from `mock`; the rest is the real service.
const mock = { legacy: { count: 2, completed: false }, unmanagedFirst: false, preview: null, previews: 0 };
async function installMocks() {
  await page.route(url => /\/api\/project-videos\/projects\/[^/]+$/.test(url.pathname), async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch(), data = await res.json();
    if (res.ok()) { data.legacyUpgrade = { ...mock.legacy }; if (mock.unmanagedFirst && data.videos?.[0]) data.videos[0] = { ...data.videos[0], managed: false }; }
    await route.fulfill({ status: res.status(), json: data });
  });
  await page.route(url => /\/api\/project-videos\/projects\/[^/]+\/upgrade$/.test(url.pathname), async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    mock.previews++; await route.fulfill({ json: mock.preview });
  });
}
async function refresh() {
  await work().getByRole('button', { name: '更多视频操作' }).click(); await page.getByRole('menuitem', { name: /刷新视频资料/ }).click();
  await expect(page.getByRole('menuitem', { name: /刷新视频资料/ })).toHaveCount(0);
}
async function menuHasUpgrade() {
  await work().getByRole('button', { name: '更多视频操作' }).click();
  const item = page.getByRole('menuitem', { name: /升级旧视频/ }), has = await item.count() > 0, text = has ? await item.textContent() : '';
  await page.keyboard.press('Escape'); if (await page.getByRole('menuitem').count()) await work().getByRole('button', { name: '更多视频操作' }).click();
  return { has, text };
}

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  projectId = (await api('/projects', { name: '旧视频升级短片' })).id;
  for (const [name, color] of [['甲.mp4', 'green'], ['乙.mp4', 'brown']]) await seedVideo(await clip(name, color), 'root');

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await installMocks();
  await page.goto(origin + '/#/project-videos'); await expect(work()).toBeVisible(); await selectProjectInBar(page, projectId);
  await work().getByRole('button', { name: '项目根目录', exact: true }).click(); await expect(cards()).toHaveCount(2);

  await check('还有待升级视频时，入口按实际数量出现（即使旧的“已完成”标记还在）', async () => {
    // The reported case: the project was marked done earlier, yet videos are not managed copies.
    mock.legacy = { count: 2, completed: true }; await refresh();
    const menu = await menuHasUpgrade(); assert.ok(menu.has, 'menu entry'); assert.match(menu.text, /2 个待升级/);
    await expect(banner()).toContainText('2 个旧视频还不是项目托管副本');
  });

  await check('详情里的“核对并升级…”同样按数量显示', async () => {
    mock.unmanagedFirst = true; await refresh();
    await cards().first().click(); const detail = work().getByRole('complementary', { name: '视频详情' });
    await expect(detail.getByRole('button', { name: '核对并升级…' })).toBeVisible();
    mock.unmanagedFirst = false;
  });

  await check('预览把状态写成中文，缺授权的那一个引导去重新定位', async () => {
    mock.preview = { previewHash: 'h1', bytes: 2048, freeBytes: 10 ** 9, items: [
      { id: 'a', name: '无授权.mp4', path: '/synthetic/无授权.mp4', bytes: 1024, adoptedShots: [], status: 'untrusted', requiresRelink: true },
      { id: 'b', name: '可升级.mp4', path: '/synthetic/可升级.mp4', bytes: 1024, adoptedShots: [], status: 'available', requiresRelink: false }] };
    await banner().getByRole('button', { name: '核对并升级…' }).click();
    await expect(modal()).toContainText('无授权.mp4'); await expect(modal()).toContainText('文件待核验'); await expect(modal()).not.toContainText('untrusted');
    const items = modal().locator('.pv-upgrade-items li');
    await expect(items.nth(0)).toContainText('请先在这个视频的详情里「重新定位」'); await expect(items.nth(1)).not.toContainText('重新定位');
    await modal().getByRole('button', { name: '取消' }).click(); await expect(modal()).toHaveCount(0);
  });

  await check('待升级数为 0 时，菜单、横幅、详情都不再显示升级入口', async () => {
    mock.legacy = { count: 0, completed: true }; await refresh();
    assert.equal((await menuHasUpgrade()).has, false); await expect(banner()).toHaveCount(0);
    await cards().first().click(); await expect(work().getByRole('button', { name: '核对并升级…' })).toHaveCount(0);
  });

  await check('连旧服务（没有 count）时沿用原来的 completed 判断', async () => {
    mock.legacy = { completed: false }; await refresh();
    assert.equal((await menuHasUpgrade()).has, true); await expect(banner()).toHaveCount(0);
    mock.legacy = { completed: true }; await refresh();
    assert.equal((await menuHasUpgrade()).has, false);
  });

  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-3000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'project-videos-legacy-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); await exited; await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
