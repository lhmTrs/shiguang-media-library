// UPDREAM-PROGRESS-V1 前端：顶栏 Updream 入口 + 只读进度面板 + 生成视频页轻入口。
// 真实本地服务（合成库）+ 拦截 /api/updream/tasks 替身，覆盖前端自己的行为：
// 入口显隐、分类、六步进度、待核对/目标未核准、已读只在可见后按版本记、新版本再提醒、读取中断保留最后已知状态、
// 迟到响应不覆盖新结果、没有任何任务控制按钮、只请求本机接口、复制内容只含白名单字段、Escape/焦点、窄屏、六主题截图。
// 不连真实队列、平台或凭据。用法：npm run build && node tests/updream-progress-ui.mjs（CREATIVE_TEST_EVIDENCE=目录 时保存截图）
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'updream-progress-ui-')));
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, context, cookie, token, passed = false; const errors = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production', MEDIA_CONTAINER: '0', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal_item'), CODEX_HOME: path.join(temp, 'codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_CODEX_AUTOCONNECT: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) {
  const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json(); if (!response.ok) throw Object.assign(Error(data.error || response.status), { data }); return data;
}
async function check(name, fn) { await fn(); console.log('PASS ' + name); }
const shot = async name => { const dir = process.env.CREATIVE_TEST_EVIDENCE; if (!dir) return; await fs.mkdir(dir, { recursive: true }); await page.screenshot({ path: path.join(dir, name + '.png') }); };

// ---- 合成任务（按后端合同 schemaVersion 1 的字段） ----
const NOW = Date.now();
const base = { createdAt: NOW - 3600e3, upstreamUpdatedAt: null, localRecordUpdatedAt: NOW - 30e3, progress: null, attention: null, delivery: null, notification: { state: 'none' }, unread: false, recordUrl: '/api/updream-progress/tasks/x' };
const target = (folder, identity = 'current') => ({ projectId: 'p-demo', projectName: '示例项目', folderId: 'f-' + folder, folderLabel: '第3集 / ' + folder, identity });
const T = {
  gen: { ...base, id: 'ud-1042', eventVersion: 'a'.repeat(64), name: '雨夜巷口 · C段 第2版', target: target('C段'), phase: 'generating', active: true, progress: { percent: 42 } },
  verify: { ...base, id: 'ud-1041', eventVersion: 'b'.repeat(64), name: '雨夜巷口 · B段 第3版 · 这是一段特别长的任务名称用来检查换行和截断是否正常显示不撑破面板', target: target('B段', 'unconfirmed'), phase: 'validating', active: true, upstreamUpdatedAt: NOW - 5e3 },
  failed: { ...base, id: 'ud-1038', eventVersion: 'c'.repeat(64), name: '晨光天台 · D段 第2版', target: target('D段'), phase: 'failed', active: false, attention: { code: 'DOWNLOAD_EXPIRED', message: '平台下载链接已过期，已停在这一步，没有自动重试。' }, notification: { state: 'sent' }, unread: true },
  done: { ...base, id: 'ud-1039', eventVersion: 'd'.repeat(64), name: '晨光天台 · A段 第1版', target: target('A段'), phase: 'imported', active: false, delivery: { verification: 'executor_recorded', projectId: 'p-demo', folderId: 'f-A段', videoId: 'vid-1', canView: true }, notification: { state: 'failed' }, unread: true },
  old: { ...base, id: 'ud-1035', eventVersion: 'e'.repeat(64), name: '雨夜巷口 · A段 第1版', target: target('A段', 'other_library'), phase: 'imported', active: false, delivery: { verification: 'executor_recorded', projectId: 'p-other', folderId: 'f', videoId: 'vid-0', canView: false }, notification: { state: 'sent' } },
  unknown: { ...base, id: 'ud-1030', eventVersion: 'f'.repeat(64), name: '记录不完整的任务', target: { projectId: null, projectName: null, folderId: null, folderLabel: null, identity: 'unconfirmed' }, phase: 'needs_review', active: false, localRecordUpdatedAt: null },
  weird: { ...base, id: 'ud-1029', eventVersion: '1'.repeat(64), name: '未知阶段', target: target('E段'), phase: 'teleporting', active: false },
};
const summary = tasks => { const activeCount = tasks.filter(t => t.active).length, unreadCount = tasks.filter(t => t.unread).length; return { activeCount, unreadCount, attentionCount: tasks.filter(t => t.attention || ['failed', 'needs_review'].includes(t.phase)).length, showEntry: activeCount > 0 || unreadCount > 0 || queue.state === 'degraded' || queue.state === 'unavailable' }; };
let tasks = [], queue = { state: 'ready', reason: null, truncated: false, invalidCount: 0 }, fail = false, delays = [], reads = [], gets = [], foreign = [];
const listBody = scope => { const list = scope === 'history' ? tasks.filter(t => !t.active) : tasks; return { schemaVersion: 1, readAt: Date.now(), queue, preferences: { state: 'ready' }, summary: summary(tasks), total: list.length, offset: 0, limit: 50, tasks: list }; };

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const s = await fetch(origin + '/api/session'); cookie = s.headers.get('set-cookie').split(';')[0]; token = (await s.json()).token;
  const projectId = (await api('/projects', { name: 'Updream 合成' })).id;

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { const u = new URL(r.url()); if (u.origin !== origin && !u.protocol.startsWith('data') && !u.protocol.startsWith('blob')) foreign.push(r.url()); });
  await context.route(u => new URL(u).pathname === '/api/updream-progress', async route => {
    gets.push(Date.now());
    const delay = delays.shift() ?? 0; const body = listBody(new URL(route.request().url()).searchParams.get('scope')); if (delay) await new Promise(r => setTimeout(r, delay));
    if (fail) return route.fulfill({ status: 503, json: { error: '本机服务暂时不可用', code: 'UNAVAILABLE' } });
    return route.fulfill({ json: body });
  });
  await context.route(u => new URL(u).pathname === '/api/updream-progress/read', async route => {
    const { items } = route.request().postDataJSON(); reads.push(...items); const marked = [], skipped = [];
    for (const i of items) { const t = tasks.find(x => x.id === i.id && x.eventVersion === i.version); if (t) { t.unread = false; marked.push(i.id); } else skipped.push(i.id); }
    return route.fulfill({ json: { schemaVersion: 1, readAt: Date.now(), marked, skipped } });
  });
  const entry = () => page.locator('.ud-entry');
  const drawer = () => page.getByRole('complementary', { name: 'Updream 视频任务' });
  const card = name => drawer().locator('.ud-card').filter({ hasText: name });
  const load = async () => { await page.goto(origin + '/?r=' + Date.now() + '#/project-videos'); await expect(page.getByRole('region', { name: '项目生成视频' })).toBeVisible(); };

  await check('U1 没有登记任务：顶栏不出现入口；生成视频页「Updream 任务记录」仍能打开记录面板', async () => {
    tasks = []; queue = { state: 'absent', reason: null, truncated: false, invalidCount: 0 }; await load();
    await page.waitForTimeout(400); await expect(entry()).toHaveCount(0);
    await page.getByRole('button', { name: 'Updream 任务记录' }).click();
    await expect(drawer()).toBeVisible(); await expect(drawer()).toContainText('Updream 任务记录'); await expect(drawer()).toContainText('本机还没有 Updream 任务记录');
    await page.keyboard.press('Escape'); await expect(drawer()).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Updream 任务记录' })).toBeFocused();
    queue = { state: 'ready', reason: null, truncated: false, invalidCount: 0 };
  });

  await check('U2 进行中 + 待处理未读 + 新结果：入口文字和标记；默认停在进行中；六步进度与百分比；长名称不撑破；目标未核准', async () => {
    tasks = [structuredClone(T.gen), structuredClone(T.verify), structuredClone(T.failed), structuredClone(T.done), structuredClone(T.old)]; await load();
    await expect(entry()).toContainText('Updream · 进行中 2'); await expect(entry()).toContainText('1 待处理'); await expect(entry()).toContainText('1 新');
    await entry().click(); await expect(drawer()).toBeVisible();
    await expect(drawer().getByRole('button', { name: '进行中 2' })).toHaveAttribute('aria-pressed', 'true');
    await expect(card('C段 第2版').locator('.ud-step[aria-current]')).toContainText('生成'); await expect(card('C段 第2版')).toContainText('生成中 · 42%');
    await expect(card('C段 第2版')).toContainText('上游最近成功更新时间未知');
    await expect(card('B段 第3版').locator('.ud-step.is-done')).toHaveCount(2); await expect(card('B段 第3版')).toContainText('没有可靠的百分比');
    await expect(card('B段 第3版')).toContainText('目标未核准');
    const box = await card('B段 第3版').boundingBox(), dbox = await drawer().boundingBox(); assert.ok(box.x + box.width <= dbox.x + dbox.width + 1, '长名称撑破面板');
    await expect(drawer().getByRole('button', { name: /暂停|继续|取消|重试|知道了|重新生成|删除/ })).toHaveCount(0);
    await shot('u2-active-1440');
  });

  await check('U3 已读：只有真正显示出来的卡片按 id+eventVersion 记已读；没显示的不清；只能查看可查看的视频', async () => {
    reads = [];
    await page.waitForTimeout(1500); assert.equal(reads.length, 0, '进行中这一栏没有未读，不该记已读');
    await drawer().getByRole('button', { name: /^已完成/ }).click();
    await expect.poll(() => reads.map(r => r.id + '@' + r.version.slice(0, 4)).sort().join(','), { timeout: 4000 }).toBe('ud-1039@dddd');
    await expect(entry()).not.toContainText('新'); await expect(entry()).toContainText('1 待处理');
    assert.equal(tasks.find(t => t.id === 'ud-1038').unread, true, '没显示过的失败任务不应被清掉');
    await expect(card('晨光天台 · A段')).toContainText('原执行方回读核对通过'); await expect(card('晨光天台 · A段')).toContainText('通知：发送失败（不影响视频结果）');
    await expect(card('晨光天台 · A段').getByRole('button', { name: '查看视频' })).toBeVisible();
    await expect(card('雨夜巷口 · A段').getByRole('button', { name: '查看视频' })).toHaveCount(0); await expect(card('雨夜巷口 · A段')).toContainText('不在当前素材库');
    await drawer().getByRole('button', { name: /^待处理/ }).click();
    await expect.poll(() => reads.some(r => r.id === 'ud-1038' && r.version === 'c'.repeat(64)), { timeout: 4000 }).toBe(true);
    await expect(card('D段 第2版')).toContainText('平台下载链接已过期'); await expect(card('D段 第2版')).toContainText('失败');
    await expect(entry()).not.toContainText('待处理');
  });

  await check('U4 后台出现新版本（新异常）：再次提醒；失败记录不会因为读过而消失；旧版本的已读会被跳过', async () => {
    const f = tasks.find(t => t.id === 'ud-1038'); f.eventVersion = '9'.repeat(64); f.unread = true; f.attention = { code: 'DOWNLOAD_EXPIRED', message: '第二次下载也失败了。' };
    await drawer().getByRole('button', { name: /^进行中/ }).click();
    await expect(entry()).toContainText('1 待处理', { timeout: 6000 });
    await drawer().getByRole('button', { name: /^待处理/ }).click(); await expect(card('D段 第2版')).toContainText('第二次下载也失败了');
    await expect.poll(() => reads.some(r => r.id === 'ud-1038' && r.version === '9'.repeat(64)), { timeout: 4000 }).toBe(true);
  });

  await check('U5 复制任务信息：只含白名单字段，没有链接、提示词或凭据', async () => {
    await card('D段 第2版').getByRole('button', { name: '复制任务信息' }).click();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(text, /Updream 任务 ud-1038/); assert.match(text, /目标：示例项目（p-demo） \/ 第3集 \/ D段/); assert.match(text, /当前状态：失败/); assert.match(text, /DOWNLOAD_EXPIRED/);
    assert.doesNotMatch(text, /https?:|token|cookie|prompt|提示词|recordUrl|\/api\//i);
  });

  await check('U6 读取中断：保留最后已知状态并标明；入口出现「进度待确认」；恢复后提示消失', async () => {
    await drawer().getByRole('button', { name: /^进行中/ }).click();
    fail = true; await expect(drawer().getByRole('alert')).toContainText('本机进度读取中断', { timeout: 6000 });
    await expect(card('C段 第2版')).toContainText('最后已知：生成中'); await expect(entry().getByRole('img', { name: '进度待确认' })).toBeVisible();
    await shot('u6-stale-1440');
    fail = false; await expect(drawer().getByText('本机进度读取中断')).toHaveCount(0, { timeout: 6000 });
  });

  await check('U7 迟到响应：先发后到的旧结果不覆盖后发先到的新结果', async () => {
    await page.keyboard.press('Escape'); await expect(drawer()).toHaveCount(0); await expect(entry()).toBeFocused();
    tasks = [structuredClone(T.gen)]; delays = [2500];
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(200); tasks = [structuredClone(T.gen), structuredClone(T.verify)];
    await entry().click();
    await expect(entry()).toContainText('进行中 2'); await page.waitForTimeout(2800);
    await expect(entry()).toContainText('进行中 2');
  });

  await check('U8 待核对：needs_review 和不认识的阶段都显示「待核对」，不当成失败或完成；目标缺失写明', async () => {
    tasks = [structuredClone(T.unknown), structuredClone(T.weird), structuredClone(T.gen)];
    await drawer().getByRole('button', { name: /^待处理/ }).click();
    await expect(card('记录不完整的任务')).toContainText('待核对', { timeout: 6000 });
    await expect(card('记录不完整的任务')).toContainText('没有当成失败或完成'); await expect(card('记录不完整的任务')).toContainText('目标未记录');
    await expect(card('未知阶段').locator('.ud-state')).toHaveText('待核对');
    await expect(drawer().getByRole('button', { name: /^已完成/ })).toBeVisible();
    await drawer().getByRole('button', { name: /^进行中/ }).click();
  });

  await check('U9 读取频率：展开约 3 秒一次，收起 15 秒一次；页面没有请求本机以外的地址', async () => {
    gets = []; await page.waitForTimeout(7000); assert.ok(gets.length >= 2 && gets.length <= 4, '展开时读取次数 ' + gets.length);
    await page.keyboard.press('Escape'); gets = []; await page.waitForTimeout(7000); assert.ok(gets.length <= 1, '收起时读取次数 ' + gets.length);
    assert.deepEqual(foreign, []);
  });

  await check('U10 队列损坏/读不了：入口照样出现并说明，列表标明可能不全', async () => {
    tasks = []; queue = { state: 'degraded', reason: 'INVALID_RECORDS', truncated: true, invalidCount: 3 }; await load();
    await expect(entry()).toBeVisible(); await expect(entry().getByRole('img', { name: '进度待确认' })).toBeVisible();
    await entry().click(); await expect(drawer()).toContainText('有 3 条读不了，已跳过'); await expect(drawer()).toContainText('只读了一部分');
    await page.keyboard.press('Escape'); queue = { state: 'ready', reason: null, truncated: false, invalidCount: 0 };
  });

  await check('U11 窄屏 390：入口只剩图标和数字，面板全宽、贴在顶栏下方，没有横向溢出', async () => {
    tasks = [structuredClone(T.gen), structuredClone(T.verify), structuredClone(T.failed), structuredClone(T.done)];
    await page.setViewportSize({ width: 390, height: 844 }); await load();
    await expect(entry().locator('.ud-entry-short')).toHaveText('2'); await expect(entry().locator('.ud-entry-label')).toBeHidden();
    await entry().click(); await expect(drawer()).toBeVisible();
    const d = await drawer().boundingBox(), bar = await page.locator('.library-topbar').boundingBox();
    assert.ok(Math.abs(d.width - 390) < 2, '面板宽 ' + d.width); assert.ok(d.y >= bar.y + bar.height - 1, '面板挡住了顶栏');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '横向溢出');
    await shot('u11-narrow-390');
    await page.keyboard.press('Escape'); await page.setViewportSize({ width: 1440, height: 900 });
  });

  await check('U12 六个主题：入口和面板都能正常显示（截图留证）', async () => {
    for (const theme of ['forest', 'dark', 'midnight', 'sepia', 'graphite', 'ocean']) {
      await page.evaluate(t => localStorage.setItem('shiguang.theme', t), theme); await load();
      await entry().click(); await expect(drawer()).toBeVisible(); await drawer().getByRole('button', { name: /^待处理/ }).click();
      const colors = await card('D段 第2版').locator('.ud-attention').evaluate(e => [getComputedStyle(e).color, getComputedStyle(e.closest('.ud-card')).backgroundColor]);
      assert.notEqual(colors[0], colors[1], theme + ' 文字与底色相同');
      await shot('u12-theme-' + theme); await page.keyboard.press('Escape');
    }
    await page.evaluate(() => localStorage.setItem('shiguang.theme', 'forest'));
  });

  assert.deepEqual(errors, []);
  passed = true; console.log('ALL PASS updream-progress-ui');
} finally {
  await browser?.close();
  if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([exited, new Promise(r => setTimeout(r, 15000))]); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
  await fs.rm(temp, { recursive: true, force: true });
  if (!passed) { console.log(logs.slice(-2000)); process.exitCode = 1; }
}
