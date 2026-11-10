// 生成视频页改版（#40）的界面检查：布局、预览、草稿、文件夹核对、导入保护、键盘菜单与窄窗口。
// 独立可写实例：数据目录与托管目录都在临时目录，测试结束后删除；视频由 ffmpeg 合成。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-videos-ui-'))), clips = path.join(temp, '合成视频'); await fs.mkdir(clips);
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
async function seedVideo(file, folderId, prompt = { mode: 'none' }) {
  const bytes = await fs.readFile(file), requestId = crypto.randomUUID();
  await api(pv('/imports'), { requestId, folderId, fileName: path.basename(file), bytes: bytes.length, prompt });
  const receipt = await api(pv(`/imports/${requestId}/content`), bytes, 'PUT'); assert.equal(receipt.status, 'ready'); return receipt.videoId;
}
const work = () => page.getByRole('region', { name: '项目生成视频' }), detail = () => work().getByRole('complementary', { name: '视频详情' });
const card = name => work().locator('.pv-card:not(.pv-folder-card)').filter({ has: page.locator('strong', { hasText: new RegExp('^' + name.replace(/[.]/g, '\\.') + '$') }) });
const chip = name => work().getByRole('navigation', { name: /视频文件夹/ }).getByRole('button', { name, exact: true });
const modal = () => page.locator('.pv-modal');
const count = { content: 0 };
try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  projectId = (await api('/projects', { name: '春日短片' })).id;
  const f1 = await api(pv('/folders'), { requestId: crypto.randomUUID(), parentId: 'root', name: '第一场' });
  const f1id = f1.id ?? f1.folder?.id ?? (await api(pv('?folderId=all'))).folders.find(f => f.name === '第一场').id;
  await api(pv('/folders'), { requestId: crypto.randomUUID(), parentId: f1id, name: '补拍' });
  await api(pv('/folders'), { requestId: crypto.randomUUID(), parentId: 'root', name: '第二场' });
  const f2id = (await api(pv('?folderId=all'))).folders.find(f => f.name === '第二场').id;
  const aId = await seedVideo(await clip('清晨远景.mp4', 'green'), 'root', { mode: 'new', title: '清晨田埂', text: '清晨薄雾，农夫沿田埂走向镜头。' });
  const bId = await seedVideo(await clip('手部特写.mp4', 'brown'), f1id);
  await seedVideo(await clip('集市跟拍.mp4', 'gray'), f1id);
  const extra = await clip('灶房夜景.mp4', 'navy'), dupSource = path.join(temp, 'dup'); await fs.mkdir(dupSource); await fs.copyFile(path.join(clips, '手部特写.mp4'), path.join(dupSource, '手部特写.mp4'));

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.method() === 'PUT' && r.url().includes('/project-videos/') && r.url().endsWith('/content')) count.content++; });
  await page.goto(origin + '/#/project-videos'); await expect(work()).toBeVisible(); await page.getByLabel('生成视频所属项目').selectOption(projectId);
  await expect(card('清晨远景.mp4')).toBeVisible();

  await check('布局：未选中时不显示详情；详情先提示词后资料，不挂播放器；页面不整体滚动', async () => {
    await expect(detail()).toHaveCount(0);
    await card('清晨远景.mp4').click(); await expect(detail()).toBeVisible();
    assert.equal(await detail().locator('video').count(), 0, '详情不应自动加载视频');
    const order = await detail().evaluate(el => { const p = el.querySelector('.pv-prompt-fields'), n = el.querySelector('.pv-basic-fields'); return !!p && !!n && !!(p.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING); });
    assert.ok(order, '参考提示词应在视频资料之前');
    const overflow = await page.evaluate(() => ({ x: document.documentElement.scrollWidth > innerWidth, y: document.scrollingElement.scrollHeight > innerHeight + 2 }));
    assert.deepEqual(overflow, { x: false, y: false });
  });

  await check('双击和 Enter 打开原视频预览，Esc 关闭', async () => {
    await card('清晨远景.mp4').dblclick(); const viewer = page.getByRole('dialog', { name: /项目原视频预览/ }); await expect(viewer).toBeVisible();
    await page.keyboard.press('Escape'); await expect(viewer).toHaveCount(0);
    await card('清晨远景.mp4').focus(); await page.keyboard.press('Enter'); await expect(viewer).toBeVisible();
    await page.keyboard.press('Escape'); await expect(viewer).toHaveCount(0);
    await detail().getByRole('button', { name: '查看原视频' }).click(); await expect(viewer).toBeVisible(); await page.keyboard.press('Escape');
  });

  await check('草稿按视频保留并标记；修订冲突时禁止保存，可放弃草稿', async () => {
    await page.getByRole('button', { name: '全部视频' }).click(); await card('清晨远景.mp4').click();
    await detail().getByLabel('备注（可选）').fill('草稿备注'); await expect(detail().getByRole('button', { name: '保存资料' })).toBeEnabled();
    await card('手部特写.mp4').click(); await expect(card('清晨远景.mp4')).toContainText('草稿未保存');
    await card('清晨远景.mp4').click(); await expect(detail().getByLabel('备注（可选）')).toHaveValue('草稿备注');
    const current = (await api(pv('?folderId=all'))).videos.find(v => v.id === aId);
    await api(pv('/videos/' + aId), { expectedRevision: current.revision, title: current.name, notes: '另一窗口', prompt: { mode: current.promptId ? 'existing' : 'none', id: current.promptId || undefined } }, 'PATCH');
    await work().getByRole('button', { name: '更多视频操作' }).click(); await page.getByRole('menuitem', { name: /刷新视频资料/ }).click();
    await expect(detail().getByRole('alert')).toContainText('资料已被其他操作更新'); await expect(detail().getByRole('button', { name: '保存资料' })).toBeDisabled();
    await detail().getByRole('button', { name: '放弃草稿，使用当前资料' }).click(); await expect(detail().getByLabel('备注（可选）')).toHaveValue('另一窗口');
  });

  await check('文件夹：全部与根目录分开；拖卡片到文件夹先打开核对，确认后才移动', async () => {
    await chip('第一场').click(); await expect(work().locator('.pv-card:not(.pv-folder-card)')).toHaveCount(2);
    await chip('项目根目录').click(); await expect(work().locator('.pv-card:not(.pv-folder-card)')).toHaveCount(1);
    await chip('全部视频').click(); await expect(work().locator('.pv-card:not(.pv-folder-card)')).toHaveCount(3);
    await chip('第一场').click(); await card('手部特写.mp4').dragTo(chip('第二场'));
    await expect(modal()).toContainText('移动视频'); assert.equal((await api(pv('?folderId=all'))).videos.find(v => v.id === bId).folderId, f1id, '拖放本身不应移动');
    await modal().getByRole('button', { name: /核对操作影响/ }).click(); await modal().getByRole('button', { name: /确认执行/ }).click();
    await expect.poll(async () => (await api(pv('?folderId=all'))).videos.find(v => v.id === bId).folderId).toBe(f2id);
    await modal().getByRole('button', { name: '返回列表' }).click().catch(() => {}); await expect(modal()).toHaveCount(0);
  });

  await check('删除文件夹：先核对影响；改删除方式后旧核对作废', async () => {
    await chip('第一场').click(); await work().getByRole('button', { name: /当前目录/ }).click(); await page.getByRole('menuitem', { name: '删除文件夹…' }).click();
    await modal().getByRole('button', { name: /核对操作影响/ }).click(); await expect(modal().locator('.pv-operation-plan')).toBeVisible();
    await expect(modal().getByRole('button', { name: /确认执行/ })).toBeVisible();
    await modal().getByLabel('删除方式').selectOption('trash').catch(() => {});
    await expect(modal().locator('.pv-operation-plan')).toHaveCount(0); await expect(modal().getByRole('button', { name: /确认执行/ })).toHaveCount(0);
    await modal().getByRole('button', { name: '取消' }).click(); await expect(modal()).toHaveCount(0);
    assert.ok((await api(pv('?folderId=all'))).folders.some(f => f.id === f1id), '未确认不应删除');
  });

  await check('导入：两步确认后保存到当前目录；同名需选择，覆盖须勾选确认', async () => {
    await chip('项目根目录').click(); await work().getByRole('button', { name: '导入视频' }).click();
    await page.locator('.pv-session:not([hidden]) input[type=file]').setInputFiles(extra);
    await modal().getByRole('button', { name: '下一步，核对导入' }).click(); await modal().getByRole('button', { name: '确认复制并导入' }).click();
    await expect(modal()).toContainText('处理已结束'); await modal().getByRole('button', { name: '返回视频列表' }).click();
    await expect(card('灶房夜景.mp4')).toBeVisible();
    await chip('第二场').click(); await work().getByRole('button', { name: '导入视频' }).click();
    await modal().getByRole('button', { name: '开始另一笔导入' }).click().catch(() => {});
    await page.locator('.pv-session:not([hidden]) input[type=file]').setInputFiles(path.join(dupSource, '手部特写.mp4'));
    await modal().getByRole('button', { name: '下一步，核对导入' }).click(); await modal().getByRole('button', { name: '确认复制并导入' }).click();
    await expect(modal().getByRole('heading', { name: '目标文件夹有同名视频' })).toBeVisible();
    await expect(modal().getByRole('button', { name: '确认覆盖同名目标' })).toBeDisabled();
    await modal().getByRole('button', { name: '保留双方，递增重命名' }).click(); await expect(modal()).toContainText('处理已结束');
    await modal().getByRole('button', { name: '返回视频列表' }).click();
    await expect(work().locator('.pv-card:not(.pv-folder-card)')).toHaveCount(2);
    const inF2 = (await api(pv('?folderId=' + f2id))).videos; assert.deepEqual(inF2.map(v => v.fileName).sort(), ['手部特写.mp4', '手部特写_0.mp4']);
  });

  await check('导入回应丢失：只能查询原请求，不重新上传', async () => {
    let dropped = false;
    await page.route('**/api/project-videos/**/content', async route => { if (dropped) return route.fallback(); dropped = true; await route.fetch(); await route.abort('failed'); });
    const before = count.content, again = path.join(temp, 'again'); await fs.mkdir(again); const lost = path.join(again, '丢回应.mp4'); await fs.copyFile(path.join(clips, '集市跟拍.mp4'), lost);
    await chip('项目根目录').click(); await work().getByRole('button', { name: '导入视频' }).click();
    await modal().getByRole('button', { name: '开始另一笔导入' }).click().catch(() => {});
    await page.locator('.pv-session:not([hidden]) input[type=file]').setInputFiles(lost);
    await modal().getByRole('button', { name: '下一步，核对导入' }).click(); await modal().getByRole('button', { name: '确认复制并导入' }).click();
    await expect(modal()).toContainText('结果尚未确认'); assert.ok(dropped);
    await modal().getByRole('button', { name: '关闭' }).click();
    const banner = work().locator('.pv-task-banner'); await expect(banner).toBeVisible();
    await banner.getByRole('button', { name: '查询原请求' }).click(); await expect(banner).toContainText('处理已结束');
    assert.equal(count.content, before + 1, '查询不应重新上传'); await page.unrouteAll({ behavior: 'wait' });
    await expect(card('丢回应.mp4')).toBeVisible();
  });

  await check('键盘：⋯ 菜单可用方向键与 Esc 操作，焦点回到按钮', async () => {
    const trigger = work().getByRole('button', { name: '更多视频操作' }); await trigger.focus(); await page.keyboard.press('Enter');
    const menu = page.getByRole('menu'); await expect(menu).toBeVisible();
    const first = await page.evaluate(() => document.activeElement?.getAttribute('role')); assert.ok(first?.startsWith('menuitem'));
    await page.keyboard.press('ArrowDown'); assert.match(await page.evaluate(() => document.activeElement?.textContent || ''), /刷新视频资料/);
    await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); await expect(trigger).toBeFocused();
  });

  await check('窄窗口（900×780）无横向溢出，详情覆盖在列表上', async () => {
    await page.setViewportSize({ width: 900, height: 780 }); if (await detail().count()) await detail().getByRole('button', { name: '关闭详情' }).click();
    await card('灶房夜景.mp4').click(); await expect(detail()).toBeVisible();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await detail().getByRole('button', { name: '关闭详情' }).click(); await expect(detail()).toHaveCount(0);
  });

  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-3000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'project-videos-ui-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); await exited; await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
