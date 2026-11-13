// 生成视频 · 多选移动（move-videos，普通文件夹）。真实本地服务 + 合成视频，不替身移动接口；
// 只在「执行中」一项里扣住回执，模拟移动还在后台完成。
// 覆盖：多选入口（右键 / 底栏）、已在目标目录的排除、整组拖动、一次核对一次确认、结果与打开目标、上一笔未完成时的说明。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { selectProjectInBar } from './helpers/path-bar.mjs';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-videos-multi-move-'))), clips = path.join(temp, '合成视频'); await fs.mkdir(clips);
const ffmpeg = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
async function clip(name, color) {
  const file = path.join(clips, name);
  const run = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=96x64:r=8:d=2`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-threads', '1', file]);
  assert.equal(run.status, 0, run.stderr?.toString()); return file;
}
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [], posts = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal_item'), CODEX_HOME: path.join(temp, 'codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_CODEX_AUTOCONNECT: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
const work = () => page.getByRole('region', { name: '项目生成视频' }), modal = () => page.locator('.pv-modal');
const card = id => work().locator(`.pv-card[data-video-id="${id}"]`);
const folderCard = name => work().locator('.pv-folder-card').filter({ hasText: name }).first();
const chipBar = () => work().getByRole('navigation', { name: /视频文件夹/ });
const where = async () => Object.fromEntries((await api(pv('?folderId=all'))).videos.map(v => [v.id, v.folderId]));
const pickMany = async ids => { await card(ids[0]).click(); for (const id of ids.slice(1)) await card(id).click({ modifiers: ['Meta'] }); };
const hold = { running: false, failGetOnce: false, dropPost: false, capturePost: false, captured: null, loseAbandon: false }; let gets = 0;
const shot = async name => { const dir = process.env.CREATIVE_TEST_EVIDENCE; if (!dir) return; await fs.mkdir(dir, { recursive: true }); await page.screenshot({ path: path.join(dir, name + '.png') }); };

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  projectId = (await api('/projects', { name: '多选移动' })).id;
  for (const name of ['第一场', '第二场']) await api(pv('/folders'), { requestId: crypto.randomUUID(), parentId: 'root', name });
  const folders = (await api(pv('?folderId=all'))).folders, F1 = folders.find(f => f.name === '第一场').id, F2 = folders.find(f => f.name === '第二场').id;
  const ids = {}; for (const [name, color, at] of [['甲.mp4', 'green', 'root'], ['乙.mp4', 'brown', 'root'], ['丙.mp4', 'gray', 'root'], ['丁.mp4', 'navy', F1], ['戊.mp4', 'purple', 'root']]) ids[name] = await seedVideo(await clip(name, color), at);
  const [A, B, C, D, E] = ['甲.mp4', '乙.mp4', '丙.mp4', '丁.mp4', '戊.mp4'].map(n => ids[n]);

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  const opBase = `/api/project-videos/projects/${projectId}/operations`;
  page.on('request', r => { const u = new URL(r.url()); if (r.method() === 'POST' && u.pathname.startsWith(opBase)) posts.push({ path: u.pathname, body: r.postDataJSON() }); });
  // 执行中：把执行回执和轮询都说成 running（真实移动已完成），放行后轮询读到真实 ready
  await page.route(u => new URL(u).pathname.startsWith(opBase + '/'), async route => {
    if (route.request().method() === 'POST' && route.request().url().endsWith('/abandon') && hold.loseAbandon) { hold.loseAbandon = false; await route.fetch(); return route.abort('connectionreset'); } // 服务端已作废，回应丢失
    if (route.request().method() !== 'GET') return route.fallback();
    gets++; if (hold.failGetOnce) { hold.failGetOnce = false; return route.abort('connectionreset'); } // 只断一次，之后网络正常
    if (!hold.running) return route.fallback();
    const id = new URL(route.request().url()).pathname.split('/').pop(); return route.fulfill({ json: { requestId: id, status: 'running', description: '移动 2 个视频', items: [] } });
  });
  await page.route(u => new URL(u).pathname === opBase, async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    if (hold.dropPost) { hold.dropPost = false; return route.abort('connectionreset'); } // 执行请求没到后台：服务端只有预览
    if (hold.capturePost) { hold.capturePost = false; hold.captured = route.request().postData(); return route.abort('connectionreset'); } // 截住原执行，稍后原样交给后端
    if (!hold.running && !hold.postRunning) return route.fallback();
    const res = await route.fetch(); const data = await res.json(); return route.fulfill({ json: { ...data, status: 'running', items: (data.items || []).map(x => ({ ...x, status: 'not-run' })) } });
  });
  await page.goto(origin + '/#/project-videos'); await expect(work()).toBeVisible(); await selectProjectInBar(page, projectId);
  await expect(card(A)).toBeVisible();

  await check('多选后有批量移动入口：右键「移动 N 个到…」、底栏「移动到…」', async () => {
    await pickMany([A, B]); await card(B).click({ button: 'right' });
    await expect(page.locator('[data-pv-menu=ctx]').getByRole('menuitem', { name: /移动 2 个到…/ })).toBeVisible(); await page.keyboard.press('Escape');
    await expect(work().getByRole('toolbar', { name: '已选视频操作' }).getByRole('button', { name: '移动到…' })).toBeVisible();
  });

  await check('全部视频里选 3 个移到「第一场」：已在那里的丁排除，只提交 2 个，一次核对一次确认，结果写明已移动', async () => {
    await chipBar().getByRole('button', { name: '全部视频' }).click(); await expect(card(D)).toBeVisible();
    await pickMany([A, B, D]); await work().getByRole('toolbar', { name: '已选视频操作' }).getByRole('button', { name: '移动到…' }).click();
    await expect(modal()).toContainText('移动 3 个视频'); await expect(modal().getByRole('button', { name: /核对 .* 个视频的移动影响/ })).toBeDisabled();
    await modal().getByLabel('目标文件夹').selectOption(F1);
    await expect(modal()).toContainText('已在「第一场」，不移动'); await expect(modal()).toContainText('其中 2 个会移动'); await shot('1-batch-target');
    posts.length = 0; await modal().getByRole('button', { name: '核对 2 个视频的移动影响' }).click();
    await expect(modal().getByRole('button', { name: '确认移动 2 个' })).toBeEnabled(); await shot('2-batch-preview');
    const pre = posts.find(p => p.path.endsWith('/preview')); assert.equal(pre.body.kind, 'move-videos'); assert.deepEqual([...pre.body.sourceIds].sort(), [A, B].sort());
    assert.equal(pre.body.destinationFolderId, F1); assert.equal(typeof pre.body.expectedRolesRevision, 'number'); assert.equal('unbindAdoptions' in pre.body, false);
    await modal().getByRole('button', { name: '确认移动 2 个' }).click();
    const run = posts.find(p => p.path === opBase); assert.deepEqual({ c: run.body.confirmUnbind, ids: run.body.confirmedUnbindShotIds }, { c: true, ids: [] });
    await expect(modal()).toContainText('已移动 2 个到「第一场」'); await shot('3-batch-done');
    const at = await where(); assert.deepEqual({ A: at[A], B: at[B], D: at[D] }, { A: F1, B: F1, D: F1 });
    await modal().getByRole('button', { name: '打开「第一场」' }).click(); await expect(modal()).toHaveCount(0);
    await expect(card(A)).toBeVisible(); await expect(card(C)).toHaveCount(0);
  });

  await check('拖动已选中的一个：带整组拖到文件夹卡，目标已选好，两个都在列表里', async () => {
    await chipBar().getByRole('button', { name: '项目根目录' }).click(); await expect(card(C)).toBeVisible();
    await pickMany([C, E]); await card(C).dragTo(folderCard('第二场'));
    await expect(modal()).toContainText('移动 2 个视频'); await expect(modal().getByLabel('目标文件夹')).toHaveValue(F2);
    await expect(modal().locator('.pv-batch-items')).toContainText('丙.mp4'); await expect(modal().locator('.pv-batch-items')).toContainText('戊.mp4');
    await modal().getByRole('button', { name: '取消' }).click(); await expect(modal()).toHaveCount(0);
    // 拖未选中的：只带它自己，走单个移动
    await work().getByRole('toolbar', { name: '已选视频操作' }).getByRole('button', { name: '取消选择' }).click();
    await card(E).dragTo(folderCard('第二场')); await expect(modal()).toContainText('移动视频'); await expect(modal()).toContainText('戊.mp4');
    await modal().getByRole('button', { name: '取消' }).click();
  });

  await check('执行中：显示「正在移动…」不说结果待核对；收起后再拖说明原因，菜单写明上一笔完成后可用；完成后恢复', async () => {
    hold.running = true; await pickMany([C, E]); await work().getByRole('toolbar', { name: '已选视频操作' }).getByRole('button', { name: '移动到…' }).click();
    await modal().getByLabel('目标文件夹').selectOption(F2); await modal().getByRole('button', { name: '核对 2 个视频的移动影响' }).click();
    await modal().getByRole('button', { name: '确认移动 2 个' }).click();
    await expect(modal()).toContainText('正在移动…'); await expect(modal()).not.toContainText('结果待核对');
    await modal().getByRole('button', { name: '在后台继续' }).click(); await expect(modal()).toHaveCount(0);
    const bar = work().locator('.pv-op-background'); await expect(bar).toContainText('完成前不能开始新的移动'); await shot('4-running-bar');
    // 移动已在后台完成（真实），把乙拖回根目录：不弹窗，说明原因
    await chipBar().getByRole('button', { name: '第一场' }).click(); await expect(card(B)).toBeVisible();
    await card(B).dragTo(chipBar().getByRole('button', { name: '项目根目录' }));
    await expect(page.getByText('上一笔移动还在完成中，完成后再移动。').first()).toBeVisible(); await expect(modal()).toHaveCount(0);
    await card(B).click({ button: 'right' }); await expect(page.locator('[data-pv-menu=ctx]').getByRole('menuitem', { name: /移动到…/ })).toContainText('上一笔完成后可用'); await page.keyboard.press('Escape');
    await bar.getByRole('button', { name: '查看进度' }).click(); await expect(modal()).toContainText('正在移动…'); await modal().getByRole('button', { name: '在后台继续' }).click();
    hold.running = false; await expect(bar).toHaveCount(0, { timeout: 10000 });
    const at = await where(); assert.deepEqual({ C: at[C], E: at[E] }, { C: F2, E: F2 });
  });


  await check('反例 R1：执行中第一次进度查询断网：不卡在「正在移动」，自动再查原编号读到完成，执行只发一次', async () => {
    await chipBar().getByRole('button', { name: '第二场' }).click(); await expect(card(C)).toBeVisible();
    hold.postRunning = true; hold.failGetOnce = true; gets = 0; posts.length = 0;
    await pickMany([C, E]); await work().getByRole('toolbar', { name: '已选视频操作' }).getByRole('button', { name: '移动到…' }).click();
    await modal().getByLabel('目标文件夹').selectOption('root'); await modal().getByRole('button', { name: '核对 2 个视频的移动影响' }).click();
    await modal().getByRole('button', { name: '确认移动 2 个' }).click(); hold.postRunning = false;
    await expect(modal()).toContainText('已移动 2 个到「项目根目录」', { timeout: 15000 });
    assert.ok(gets >= 2, '断网后应再查原编号'); assert.equal(posts.filter(p => p.path === opBase).length, 1, '执行不应重发');
    await modal().getByRole('button', { name: '留在这里' }).click(); await expect(work().locator('.pv-op-background')).toHaveCount(0);
  });

  // R2（接口对齐后）：读到「尚未开始」不解锁；「放下这笔」由服务端原子作废。两种先后顺序各一条，再加作废回应丢失
  const captureNextPost = () => { hold.capturePost = true; hold.captured = null; };
  const deliverCaptured = async () => { const r = await fetch(origin + '/api/project-videos/projects/' + encodeURIComponent(projectId) + '/operations', { method: 'POST', headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, body: hold.captured }); return { status: r.status, body: await r.json() }; };
  async function startStuckMove(from, ids, target) {
    await chipBar().getByRole('button', { name: from }).click(); await expect(card(ids[0])).toBeVisible();
    captureNextPost(); await pickMany(ids); await work().getByRole('toolbar', { name: '已选视频操作' }).getByRole('button', { name: '移动到…' }).click();
    await modal().getByLabel('目标文件夹').selectOption(target); await modal().getByRole('button', { name: `核对 ${ids.length} 个视频的移动影响` }).click();
    await modal().getByRole('button', { name: `确认移动 ${ids.length} 个` }).click(); await expect(modal()).toContainText('结果待核对');
    await expect(modal().getByRole('button', { name: '恢复原操作（回滚）' })).toHaveCount(0);
    await modal().getByRole('button', { name: '查询原文件夹操作' }).click(); await expect(modal()).toContainText('尚未开始');
    await expect(modal().getByRole('button', { name: '恢复原操作（回滚）' })).toHaveCount(0);
  }
  await check('反例 R2a：读到「尚未开始」仍锁住；放下先到 → 迟到的原执行被拒（409），文件不动，页面回到核对前', async () => {
    await startStuckMove('第一场', [A, B], F2);
    await modal().getByRole('button', { name: '返回列表' }).click();
    await expect(work().locator('.pv-op-background')).toContainText('移动尚未开始');
    await card(A).dragTo(chipBar().getByRole('button', { name: '第二场' })); await expect(page.getByText('上一笔移动还在完成中，完成后再移动。').first()).toBeVisible();
    await work().locator('.pv-op-background').getByRole('button', { name: '查看进度' }).click();
    await modal().getByRole('button', { name: '放下这笔，重新核对' }).click(); await expect(work().locator('.pv-op-background')).toHaveCount(0);
    const late = await deliverCaptured(); assert.equal(late.status, 409); assert.equal(late.body.code, 'OPERATION_ABANDONED');
    const at = await where(); assert.deepEqual({ A: at[A], B: at[B] }, { A: F1, B: F1 });
  });

  await check('反例 R2b：原执行先登记再点放下 → 不放下，继续跟踪同一编号直到完成', async () => {
    if (await modal().count()) await modal().getByRole('button', { name: /取消|返回列表|关闭/ }).first().click();
    await startStuckMove('第一场', [A, B], F2);
    const first = await deliverCaptured(); assert.equal(first.status < 300, true, '原执行应登记成功');
    await modal().getByRole('button', { name: '放下这笔，重新核对' }).click();
    await expect(modal()).toContainText('已移动 2 个到「第二场」', { timeout: 15000 });
    const at = await where(); assert.deepEqual({ A: at[A], B: at[B] }, { A: F2, B: F2 });
    await modal().getByRole('button', { name: '留在这里' }).click();
  });

  await check('反例 R2c：放下的回应丢失 → 不自动重发执行；查询读到已放下后解锁', async () => {
    await startStuckMove('第二场', [A, B], F1); posts.length = 0; hold.loseAbandon = true;
    await modal().getByRole('button', { name: '放下这笔，重新核对' }).click(); await expect(page.getByText(/放下结果尚未确认/).first()).toBeVisible();
    await modal().getByRole('button', { name: '查询原文件夹操作' }).click(); await expect(work().locator('.pv-op-background')).toHaveCount(0);
    assert.equal(posts.filter(p => p.path === opBase).length, 0, '不应重发执行');
    const at = await where(); assert.deepEqual({ A: at[A], B: at[B] }, { A: F2, B: F2 });
  });

  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-3000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'pv-multi-move-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); let timer; if (await Promise.race([exited, new Promise(r => timer = setTimeout(() => r('timeout'), 10000))]) === 'timeout') { child.kill('SIGKILL'); await exited; } clearTimeout(timer);
  await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
