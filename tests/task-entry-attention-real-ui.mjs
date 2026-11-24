// 任务入口两件 组合联调：真实前端 + 真实后端，不拦截任何接口。合成库、合成文件任务回执、合成 Updream 跟进队列（tests/helpers/updream-progress-fixture.mjs）。
// 复现三种现场（Codex 后端冻结 912ba76 的组合探针口径）：
//   ① 52 个较新的成功批次压住两个较早的待处理批次 → 顶栏按批数，打开直接落在待处理，标为已处理后跳下一批；
//   ② 23 条找不到本地状态文件的历史记录（21 条旧记录记完成、2 条记失败）→ 只在底部诊断行，不计数、不点亮读取警告；
//   ③ 3 条真实新结果 → Updream 顶栏只显示「3 新」。
// 不点重试、不复制文件、不连平台。用法：npm run build && node tests/task-entry-attention-real-ui.mjs（CREATIVE_TEST_EVIDENCE=目录 时保存截图）
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { progressFixture } from './helpers/updream-progress-fixture.mjs';

const root = path.resolve(import.meta.dirname, '..');
const f = await progressFixture();
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production', MEDIA_CONTAINER: '0', MEDIA_DATA_DIR: f.data, MEDIA_UPDREAM_QUEUE_DIR: f.queue, MEDIA_PERSONAL_ITEM_DIR: path.join(f.root, 'personal'), CODEX_HOME: path.join(f.root, 'codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_CODEX_AUTOCONNECT: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' };
let child, logs = '', exited, browser, page, cookie, token, passed = false; const errors = [], foreign = [], posts = [];
function start() { logs = ''; child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); exited = new Promise(r => child.once('exit', (code, signal) => r({ code, signal }))); return expect.poll(() => logs, { timeout: 25000 }).toContain(origin); }
async function stop() { child.kill('SIGTERM'); const r = await Promise.race([exited, new Promise(x => setTimeout(() => x('timeout'), 20000))]); assert.notEqual(r, 'timeout', '服务没有正常退出'); assert.ok(logs.includes('APPLICATION_CLOSED_KNOWN'), '没有正常关闭：' + logs.slice(-400)); }
async function session() { const s = await fetch(origin + '/api/session'); cookie = s.headers.get('set-cookie').split(';')[0]; const j = await s.json(); token = j.token; return j; }
async function api(p, body) { const r = await fetch(origin + '/api' + p, { method: body ? 'POST' : 'GET', headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const data = await r.json(); if (!r.ok) throw Object.assign(Error(data.error || r.status), { data }); return data; }
async function check(name, fn) { await fn(); console.log('PASS ' + name); }
const shot = async name => { const dir = process.env.CREATIVE_TEST_EVIDENCE; if (!dir) return; await fs.mkdir(dir, { recursive: true }); await page.screenshot({ path: path.join(dir, name + '.png') }); };

try {
  // 第一次启动只为拿到素材库实例编号和建一个合成项目；回执要在服务启动前写好，按这个库的编号登记。
  await start(); const { instanceId } = await session(); assert.ok(instanceId);
  const project = await api('/projects', { name: '任务入口组合联调' });
  await stop();

  const batchesDir = path.join(f.data, 'file-intake', 'batches'), base = Date.now() - 3600e3, ids = { pendOld: crypto.randomUUID(), pendNew: crypto.randomUUID(), newest: '' };
  const item = (name, status, extra = {}) => ({ id: crypto.randomUUID(), name, bytes: 1, copiedBytes: 1, status, ...extra });
  async function receipt(id, at, status, items) {
    const row = { id, libraryId: instanceId, projectId: project.id, projectName: project.name, folderId: 'root', folderName: '', mode: 'copy', createdAt: at, updatedAt: at, status, items };
    await fs.writeFile(path.join(batchesDir, id + '.json'), JSON.stringify(row), { mode: 0o600 });
  }
  await receipt(ids.pendOld, base + 1000, 'partial', [item('较早待处理-失败.mp4', 'failed', { code: 'INTAKE_NOT_STARTED', error: '合成：没有开始复制' })]);
  await receipt(ids.pendNew, base + 2000, 'partial', [item('原件被改.mp4', 'failed', { code: 'INTAKE_SOURCE_CHANGED', error: '确认之后原文件被改过，没有收纳' }), item('原件保留.mp4', 'source_retained', { videoId: crypto.randomUUID() })]);
  for (let n = 0; n < 52; n++) { const id = crypto.randomUUID(); if (n === 51) ids.newest = id; await receipt(id, base + 3000 + n * 1000, 'completed', [item(`较新成功-${n}.mp4`, 'ready', { videoId: crypto.randomUUID() })]); }
  for (let n = 0; n < 23; n++) { const job = await f.put('historic-' + n, { stage: n < 21 ? 'done' : 'failed' }); await fs.unlink(job.source); }
  for (let n = 0; n < 3; n++) { const id = 'delivered-' + n; await f.put(id, { stage: 'done' }, { generation: { task_id: id, status: 'completed' }, delivery: f.delivered(id) }); }

  await start(); await session();
  const status = await api('/file-intake/status');
  assert.deepEqual([status.needsAttentionBatches, status.needsAttentionFiles, status.needsAttention], [2, 3, 3], '回执要按这个库登记成两批待处理');

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.setDefaultTimeout(8000); page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { const u = new URL(r.url()); if (u.origin !== origin && !u.protocol.startsWith('data') && !u.protocol.startsWith('blob')) foreign.push(r.url()); if (r.method() === 'POST' && u.pathname.startsWith('/api/')) posts.push(u.pathname); });
  await page.goto(origin + '/#/project-videos'); await expect(page.getByRole('region', { name: '项目生成视频' })).toBeVisible();
  const fileEntry = page.getByRole('button', { name: /^文件任务/ }), fileDrawer = page.getByRole('dialog', { name: '文件任务', exact: true }), select = () => fileDrawer.getByLabel('选择文件收纳批次');
  const ud = page.locator('.ud-entry'), udDrawer = page.getByRole('complementary', { name: 'Updream 视频任务' });

  await check('C1 文件任务：顶栏按批数；52 批较新的成功批次压着，打开仍直接落在较新的那批待处理', async () => {
    await expect(fileEntry).toContainText('2 批待处理'); await expect(fileEntry).not.toContainText('3 待处理');
    await fileEntry.click(); await expect(fileDrawer).toBeVisible();
    await expect(select()).toHaveValue(ids.pendNew);
    await expect(fileDrawer.locator('.fi-heading-attention')).toHaveText('2 批待处理 · 共 3 个文件');
    await expect(fileDrawer.locator('.fi-pending-hint')).toHaveText('还有 1 批待处理：任务入口组合联调 / 根目录 ▸');
    const options = await select().locator('option:not([disabled])').evaluateAll(list => list.map(o => [o.value, o.textContent]));
    assert.deepEqual(options.slice(0, 2).map(o => o[0]), [ids.pendNew, ids.pendOld]); assert.match(options[0][1], /· 2 个文件待处理$/); assert.equal(options.length, 52, '50 批最近 + 2 批待处理');
    const changed = fileDrawer.locator('.fi-item').filter({ hasText: '原件被改.mp4' });
    await expect(changed).toContainText('请回访达重新选择原文件'); await expect(changed.getByRole('button')).toHaveCount(0);
    await shot('c1-file-landing');
  });

  await check('C2 文件任务：标为已处理后跳到下一批待处理（真实回执里的重试按钮可见但不点）；都处理完才回到最新一批', async () => {
    await fileDrawer.getByRole('button', { name: '标记已处理', exact: true }).click();
    await expect(select()).toHaveValue(ids.pendOld); await expect(fileEntry).toContainText('1 批待处理');
    await expect(fileDrawer.locator('.fi-item').filter({ hasText: '较早待处理-失败.mp4' }).getByRole('button', { name: '重试此失败项', exact: true })).toBeVisible();
    await fileDrawer.getByRole('button', { name: '标记已处理', exact: true }).click();
    await expect(select()).toHaveValue(ids.newest); await expect(fileEntry).not.toContainText('待处理'); await expect(fileDrawer.locator('.fi-pending-hint')).toHaveCount(0);
    assert.deepEqual((await api('/file-intake/status')).needsAttentionBatches, 0);
    await page.keyboard.press('Escape'); await expect(fileDrawer).toHaveCount(0);
  });

  await check('C3 Updream：顶栏只显示「3 新」；23 条历史缺失不计入待处理、不点亮读取警告', async () => {
    await expect(ud).toContainText('3 新'); await expect(ud).not.toContainText('待处理'); await expect(ud.getByRole('img', { name: '进度待确认' })).toHaveCount(0);
    await ud.click(); await expect(udDrawer).toBeVisible();
    await expect(udDrawer.getByRole('button', { name: '已完成 · 3 新', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(udDrawer.getByRole('button', { name: '待处理 0', exact: true })).toBeVisible();
    await expect(udDrawer.locator('.ud-card')).toHaveCount(3);
    const line = udDrawer.locator('.ud-diag-line');
    await expect(line).toHaveText('23 条本机任务记录无法核对（找不到对应的本地状态文件）· 其中 2 条旧记录曾标为失败');
    await expect(udDrawer).not.toContainText('读不了'); await expect(udDrawer).not.toContainText('读不全');
    await line.click(); const rows = udDrawer.locator('.ud-diag-table tbody tr');
    await expect(rows).toHaveCount(23); await expect(udDrawer.locator('.ud-diag-note')).toHaveCount(0);
    await expect(rows.filter({ hasText: '未核实：失败' })).toHaveCount(2); await expect(rows.filter({ hasText: '未核实：完成' })).toHaveCount(21);
    await expect(udDrawer.locator('.ud-diag').getByRole('button')).toHaveCount(1);
    await udDrawer.getByRole('button', { name: /^待处理/ }).click(); await expect(udDrawer).toContainText('最近没有需要处理的任务'); await expect(line).toBeVisible();
    await shot('c3-updream-diagnostics');
    await expect(ud).not.toContainText('新', { timeout: 10000 });   // 卡片看过以后「新」消失；诊断不会变成未读
    await page.keyboard.press('Escape'); await expect(udDrawer).toHaveCount(0);
  });

  assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
  assert.ok(posts.every(p => p.endsWith('/acknowledge') || p === '/api/updream-progress/read'), '只有标为已处理和记已读两种写请求：' + posts.join(','));
  await page.close(); await stop();
  passed = true; console.log('ALL PASS task-entry-attention-real-ui');
} finally {
  await browser?.close();
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([exited, new Promise(r => setTimeout(r, 15000))]); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
  await fs.rm(f.root, { recursive: true, force: true });
  if (!passed) { console.log(logs.slice(-2000)); process.exitCode = 1; }
}
