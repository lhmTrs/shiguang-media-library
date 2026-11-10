// 生成视频页多选、右键复制、批量在访达中显示（#46）的界面检查。
// 后端桌面接口（合同 v1）尚未实现：这里用 page.route 模拟 clipboard / reveal / desktop-actions 与列表 capabilities，
// 只验证前端行为，不代表接口已接通。不触碰真实剪贴板或访达（单个“在访达中显示”也被拦截）。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-videos-multi-'))), clips = path.join(temp, '合成视频'); await fs.mkdir(clips);
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
const work = () => page.getByRole('region', { name: '项目生成视频' }), library = () => work().getByRole('region', { name: '视频列表' });
const cards = () => work().locator('.pv-card[data-video-id]');
const card = name => work().locator('.pv-card[data-video-id]').filter({ has: page.locator('strong', { hasText: new RegExp('^' + name.replace(/[.]/g, '\\.') + '$') }) });
const bar = () => work().getByRole('toolbar', { name: '已选视频操作' });
const banner = () => work().locator('.pv-desktop-banner');
const modal = () => page.locator('.pv-modal');

// ---- 合同 v1 模拟 ----
const mock = { capabilities: { version: 1, maxSelection: 50, clipboard: { available: true }, revealMany: { available: true } }, posts: [], receipts: new Map(), dropNextClipboard: false, staleNextReveal: false, singleReveal: 0 };
async function installMocks() {
  await page.route(url => /\/api\/project-videos\/projects\/[^/]+$/.test(url.pathname), async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const data = await (await route.fetch()).json(); data.capabilities = mock.capabilities; await route.fulfill({ json: data });
  });
  await page.route('**/api/project-videos/projects/*/videos/clipboard', async route => {
    const body = route.request().postDataJSON(); mock.posts.push({ kind: 'clipboard', body });
    const all = body.ids.map(id => ({ id, name: 'v-' + id.slice(0, 4), managed: true }));
    const final = { requestId: body.requestId, projectId, action: 'clipboard', status: all.length > 1 ? 'partial' : 'completed', requestedCount: all.length, count: all.length > 1 ? all.length - 1 : 1, copied: all.length > 1 ? all.slice(0, -1) : all, skipped: all.length > 1 ? [{ id: all.at(-1).id, name: all.at(-1).name, code: 'SOURCE_MISSING', reason: '文件缺失' }] : [] };
    mock.receipts.set(body.requestId, final);
    if (mock.dropNextClipboard) { mock.dropNextClipboard = false; return route.abort('failed'); }
    await route.fulfill({ status: 202, json: { requestId: body.requestId, projectId, action: 'clipboard', status: 'checking', processed: 0, total: all.length } });
  });
  await page.route('**/api/project-videos/projects/*/desktop-actions/*', async route => {
    const id = decodeURIComponent(route.request().url().split('/').pop()); const r = mock.receipts.get(id);
    await route.fulfill(r ? { json: r } : { status: 404, json: { error: '没有这笔请求', code: 'NOT_FOUND' } });
  });
  await page.route('**/api/project-videos/projects/*/videos/reveal/preview', async route => {
    const body = route.request().postDataJSON(); mock.posts.push({ kind: 'reveal-preview', body });
    await route.fulfill({ json: { requestId: body.requestId, projectId, status: 'completed', previewToken: 'tok-' + body.requestId.slice(0, 6), expiresAt: Date.now() + 120000, eligible: body.ids.map(id => ({ id, name: id, managed: true })), skipped: [], folderCount: 2, folders: [{ key: 'a', label: '项目根目录', count: body.ids.length - 1 }, { key: 'b', label: '第一场', count: 1 }] } });
  });
  await page.route('**/api/project-videos/projects/*/videos/reveal', async route => {
    const body = route.request().postDataJSON(); mock.posts.push({ kind: 'reveal', body });
    if (mock.staleNextReveal) { mock.staleNextReveal = false; return route.fulfill({ status: 409, json: { error: '核对后文件已变化', code: 'PREVIEW_STALE' } }); }
    await route.fulfill({ json: { requestId: body.requestId, projectId, action: 'reveal', status: 'completed', requested: body.ids.map(id => ({ id })), skipped: [], count: body.ids.length, folderCount: 2, ack: 'dispatched' } });
  });
  // 单个“在访达中显示”也拦截，测试不打开真实访达
  await page.route(url => /\/videos\/[^/]+\/reveal$/.test(url.pathname) && !url.pathname.endsWith('/videos/reveal'), async route => { mock.singleReveal++; await route.fulfill({ json: { ok: true } }); });
}
const posts = kind => mock.posts.filter(p => p.kind === kind);

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  projectId = (await api('/projects', { name: '多选短片' })).id;
  await api(pv('/folders'), { requestId: crypto.randomUUID(), parentId: 'root', name: '第一场' });
  const f1 = (await api(pv('?folderId=all'))).folders.find(f => f.name === '第一场').id;
  for (const [name, color] of [['甲.mp4', 'green'], ['乙.mp4', 'brown'], ['丙.mp4', 'gray'], ['丁.mp4', 'navy']]) await seedVideo(await clip(name, color), 'root');
  await seedVideo(await clip('戊.mp4', 'purple'), f1);

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await installMocks();
  await page.goto(origin + '/#/project-videos'); await expect(work()).toBeVisible(); await page.locator('.topbar-project-slot select').selectOption(projectId);
  await work().getByRole('button', { name: '项目根目录', exact: true }).click(); await expect(cards()).toHaveCount(4);
  const order = await cards().evaluateAll(list => list.map(el => el.querySelector('strong').textContent));

  await check('单选详情有常驻“在访达中显示”，单个仍走原接口', async () => {
    await card(order[0]).click(); const detail = work().getByRole('complementary', { name: '视频详情' });
    await detail.getByRole('button', { name: '在访达中显示' }).click(); await expect.poll(() => mock.singleReveal).toBe(1);
    assert.equal(posts('reveal-preview').length, 0, '单个不走批量核对');
  });

  await check('⌘ 单击加选、⇧ 单击连选；多选时显示操作栏与汇总', async () => {
    await card(order[0]).click(); await card(order[2]).click({ modifiers: ['Meta'] });
    await expect(bar()).toContainText('已选 2 个视频'); await expect(work().getByRole('complementary', { name: '已选视频' })).toBeVisible();
    await expect(work().getByRole('complementary', { name: '视频详情' })).toHaveCount(0);
    await card(order[2]).click({ modifiers: ['Meta'] }); await expect(bar()).toHaveCount(0); await expect(work().getByRole('complementary', { name: '视频详情' })).toBeVisible();
    await card(order[0]).click(); await card(order[3]).click({ modifiers: ['Shift'] }); await expect(bar()).toContainText('已选 4 个视频');
  });

  await check('⌘A 只全选当前可见视频，Esc 取消；在空白处拖动框选', async () => {
    await card(order[1]).click(); await page.keyboard.press('Meta+A'); await expect(bar()).toContainText('已选 4 个视频');
    await page.keyboard.press('Escape'); await expect(bar()).toHaveCount(0);
    const box = await library().boundingBox(), first = await card(order[0]).boundingBox();
    const startX = box.x + box.width - 30, startY = box.y + box.height - 30;
    await page.mouse.move(startX, startY); await page.mouse.down(); await page.mouse.move(startX - 40, startY - 40, { steps: 3 });
    await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2, { steps: 8 }); // 框住第一张视频卡到右下角之间的所有卡片
    await expect(work().locator('.pv-marquee')).toBeVisible(); await page.mouse.up();
    await expect(work().locator('.pv-marquee')).toHaveCount(0);
    const selected = await cards().evaluateAll(list => list.filter(el => el.getAttribute('aria-pressed') === 'true').length);
    assert.ok(selected >= 2, '框选应选中至少两个视频，实际 ' + selected);
  });

  await check('右键复制：按可见顺序提交，202 进度后显示复制数与跳过原因；只说“复制到系统剪贴板”', async () => {
    await card(order[0]).click(); await card(order[2]).click({ modifiers: ['Meta'] }); await card(order[1]).click({ modifiers: ['Meta'] });
    await card(order[2]).click({ button: 'right' }); const menu = page.getByRole('menu', { name: '视频操作' });
    await expect(menu.getByRole('menuitem', { name: /复制 3 个视频文件/ })).toBeVisible(); await menu.getByRole('menuitem', { name: /复制 3 个视频文件/ }).click();
    await expect(banner()).toContainText('已将 2 个视频文件复制到系统剪贴板'); await expect(banner()).toContainText('跳过 1 个');
    const sent = posts('clipboard').at(-1).body, ids = await Promise.all(order.slice(0, 3).map(n => card(n).getAttribute('data-video-id')));
    assert.deepEqual(sent.ids, ids, '按当前可见顺序提交'); assert.match(sent.requestId, /^[0-9a-f-]{36}$/);
    assert.ok(!(await banner().textContent()).includes('已粘贴'));
    await banner().locator('summary').click(); await expect(banner()).toContainText('文件缺失'); await expect(banner()).toContainText('⌘⌥V');
    await banner().getByRole('button', { name: '收起提示' }).click(); await expect(banner()).toHaveCount(0);
  });

  await check('⌘C：网格内复制；搜索框里的 ⌘C 不被接管', async () => {
    const before = posts('clipboard').length;
    await work().getByLabel('搜索视频').fill('甲'); await work().getByLabel('搜索视频').press('Meta+C'); await page.waitForTimeout(300);
    assert.equal(posts('clipboard').length, before, '输入框内 ⌘C 不应触发复制');
    await work().getByLabel('搜索视频').fill('');
    await card(order[3]).click(); await page.keyboard.press('Meta+C'); await expect(banner()).toContainText('已将 1 个视频文件复制到系统剪贴板');
    assert.equal(posts('clipboard').length, before + 1); await banner().getByRole('button', { name: '收起提示' }).click();
  });

  await check('复制回应丢失：显示结果待核对，只查询原请求，不重发', async () => {
    mock.dropNextClipboard = true; const before = posts('clipboard').length;
    await card(order[0]).click(); await card(order[1]).click({ modifiers: ['Meta'] }); await bar().getByRole('button', { name: '复制' }).click();
    await expect(banner()).toContainText('结果待核对'); await expect(bar().getByRole('button', { name: '复制' })).toBeDisabled();
    await banner().getByRole('button', { name: '查询原请求' }).click(); await expect(banner()).toContainText('已将 1 个视频文件复制到系统剪贴板');
    assert.equal(posts('clipboard').length, before + 1, '查询不应重新提交');
    await banner().getByRole('button', { name: '收起提示' }).click();
  });

  await check('批量在访达中显示：先核对目录数，确认后才执行；核对过期要求重新核对', async () => {
    await card(order[0]).click(); await card(order[1]).click({ modifiers: ['Meta'] }); await card(order[2]).click({ modifiers: ['Meta'] });
    await bar().getByRole('button', { name: '在访达中显示' }).click();
    await expect(modal()).toContainText('将在 2 个目录中定位 3 个文件'); assert.equal(posts('reveal').length, 0, '确认前不执行');
    await modal().getByRole('button', { name: /在访达中定位 3 个文件/ }).click(); await expect(modal()).toContainText('已请求在访达显示 3 个文件');
    const run = posts('reveal').at(-1).body, preview = posts('reveal-preview').at(-1).body;
    assert.equal(run.previewToken, 'tok-' + preview.requestId.slice(0, 6)); assert.notEqual(run.requestId, preview.requestId); assert.deepEqual(run.ids, preview.ids);
    await modal().getByRole('button', { name: '完成' }).click(); await expect(modal()).toHaveCount(0);
    mock.staleNextReveal = true; await bar().getByRole('button', { name: '在访达中显示' }).click();
    await modal().getByRole('button', { name: /在访达中定位/ }).click(); await expect(modal()).toContainText('请重新核对');
    await modal().getByRole('button', { name: '重新核对' }).click(); await expect(modal()).toContainText('将在 2 个目录中定位');
    await modal().getByRole('button', { name: '取消' }).click(); await expect(modal()).toHaveCount(0);
  });

  await check('能力不可用时禁用复制并说明原因；切到别的目录后多选被清除', async () => {
    mock.capabilities = { ...mock.capabilities, clipboard: { available: false, code: 'LOCAL_SESSION_REQUIRED', reason: '只能在运行拾光的这台 Mac 上使用。' } };
    await work().getByRole('button', { name: '更多视频操作' }).click(); await page.getByRole('menuitem', { name: /刷新视频资料/ }).click();
    await card(order[0]).click(); await card(order[1]).click({ modifiers: ['Meta'] });
    await expect(bar().getByRole('button', { name: '复制' })).toBeDisabled(); await expect(bar()).toContainText('只能在运行拾光的这台 Mac 上使用');
    await work().getByRole('button', { name: '第一场', exact: true }).click(); await expect(bar()).toHaveCount(0); await expect(cards()).toHaveCount(1);
  });

  await check('单卡拖到文件夹仍然只打开移动核对', async () => {
    await work().getByRole('button', { name: '项目根目录', exact: true }).click(); await expect(cards()).toHaveCount(4);
    await card(order[0]).dragTo(work().getByRole('button', { name: '第一场', exact: true }));
    await expect(modal()).toContainText('移动视频'); await modal().getByRole('button', { name: '取消' }).click();
  });

  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-3000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'project-videos-multi-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); await exited; await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
