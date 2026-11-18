// 待看去噪与按版本查看的前后端组合界面测试：真实本地服务（全新合成库）+ 无头浏览器，不拦截接口。不连真实库、4317、平台或模型。
// 用法：npm run build && node tests/storyboard-pending-version-ui.mjs（CREATIVE_TEST_EVIDENCE=目录 时保存截图）
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { selectProjectInBar } from './helpers/path-bar.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'storyboard-pending-version-ui-')));
const s0 = net.createServer(); await new Promise(r => s0.listen(0, '127.0.0.1', r)); const port = s0.address().port; await new Promise(r => s0.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const errors = [], foreign = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production', MEDIA_CONTAINER: '0', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'p'), CODEX_HOME: path.join(temp, 'c'), MEDIA_UPDREAM_QUEUE_DIR: path.join(temp, 'no-queue'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_CODEX_AUTOCONNECT: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', (code, signal) => r({ code, signal })));
async function api(p, body, method) {
  const r = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json(); if (!r.ok) throw Object.assign(Error(p + ' ' + r.status + ' ' + JSON.stringify(d).slice(0, 300)), { status: r.status, data: d }); return d;
}
async function check(name, fn) { await fn(); console.log('PASS ' + name); }
const shot = async name => { const dir = process.env.CREATIVE_TEST_EVIDENCE; if (!dir) return; await fs.mkdir(dir, { recursive: true }); await page.screenshot({ path: path.join(dir, name + '.png') }); };
const shotsOf = p => p.scenes.flatMap(s => s.shots);

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const s = await fetch(origin + '/api/session'); cookie = s.headers.get('set-cookie').split(';')[0]; token = (await s.json()).token;
  const main = await api('/projects', { name: '合成 · 待看按版本' }), base = '/storyboard/projects/' + main.id;
  const example = JSON.parse(await fs.readFile(path.join(root, 'server/storyboard/example.json'), 'utf8'));
  await api(base + '/initialize', { request_id: randomUUID(), source: example, expected_revision: null, filename: '示例.json', timing: 'duration' });
  const save = async (edit, change) => { const cur = await api(base), p = structuredClone(cur.project); edit(p); return api(base, { project: p, expected_revision: cur.revision, change, request_id: randomUUID() }, 'PUT'); };
  const agent = (edit, reason, category = 'shot_feel') => save(edit, { author: 'agent', reason_category: category, reason_text: reason });
  const first = await agent(p => { shotsOf(p)[1].framing = '合成：近景，略俯拍'; shotsOf(p)[2].camera = '合成：缓慢推近'; }, '这几镜不够有镜头感');
  const initial = await api(base), deleted = shotsOf(initial.project)[19];
  const second = await agent(p => { const sc = p.scenes.find(x => x.shots.some(q => q.id === deleted.id)); sc.shots = sc.shots.filter(q => q.id !== deleted.id); }, '删掉重复的一镜', 'miscommunication');
  const third = await agent(p => { p.scenes[0].location = '合成：新地点'; p.title = '合成：新标题'; }, '场景地点写错了', 'prompt_wrong');
  const current = await save(p => { shotsOf(p)[0].action += ' 合成：用户自己改的。'; }, { author: 'user' });
  const before = await api(base + '/pending');
  assert.deepEqual(before.pending_versions.map(v => v.version), [third.revision, second.revision, first.revision]);
  assert.equal(before.pending_count, 3, '删一镜不让后面的镜头进待看');

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => { localStorage.setItem('shiguang.refreshSeconds', '0'); });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { const u = new URL(r.url()); if (u.origin !== origin && !['data:', 'blob:'].includes(u.protocol)) foreign.push(r.url()); });
  const tab = name => page.getByRole('group', { name: '分镜视图' }).getByRole('button', { name });
  const panel = () => page.getByLabel('待看的修改', { exact: true });
  const button = name => panel().getByRole('button', { name });
  const open = async () => { await page.goto(origin + '/?r=' + Date.now() + '#/storyboards'); await selectProjectInBar(page, main.id); await expect(page.getByRole('table', { name: '可编辑分镜表' })).toBeVisible({ timeout: 15000 }); await tab(/待看的修改/).click(); await expect(panel()).toBeVisible(); };

  await check('P1 默认落在最近一版没看的；当前版本没有待看时写明；计数与全部未看一致', async () => {
    await open();
    await expect(button('当前版本')).toHaveAttribute('aria-pressed', 'true');
    await expect(button(/全部未看 · 5 处/)).toBeVisible(); await expect(tab(/待看的修改/).locator('b')).toHaveText('5');
    await expect(panel().getByRole('strong').filter({ hasText: 'V' + third.revision })).toBeVisible();
    await expect(panel()).toContainText(`当前版本 V${current.revision} 没有待看内容，这是最近一版还没看的`);
    await expect(panel()).toContainText('前面还有 2 版没看'); await expect(panel()).toContainText('场景地点写错了'); await expect(panel()).toContainText('合成：新地点');
    await shot('p1-version-landing');
  });

  await check('P2 一版一版翻：删镜用一句话，不显示原始数据；每版是自己的原话', async () => {
    await button('上一版').click();
    await expect(panel()).toContainText('删掉重复的一镜'); await expect(panel()).toContainText('前面还有 1 版没看'); await expect(panel()).toContainText('后面还有 1 版没看');
    await expect(panel().locator('.sb-change')).toHaveCount(1);
    await expect(panel().locator('.sb-change')).toContainText(`删除了镜 20：${deleted.framing}`); await expect(panel()).not.toContainText('"id"'); await shot('p2-deleted-shot');
  });

  await check('P3「这一版看过了」只清这一版，跳到更早的未看版本；更新的版本还在', async () => {
    await button('这一版看过了').click();
    await expect(panel()).toContainText('这几镜不够有镜头感'); await expect(panel()).toContainText('合成：近景，略俯拍'); await expect(button(/全部未看 · 4 处/)).toBeVisible();
    const left = await api(base + '/pending'); assert.deepEqual(left.pending_versions.map(v => v.version), [third.revision, first.revision]);
    await expect(panel()).toContainText('前面没有没看的版本了'); await shot('p3-after-clear');
  });

  await check('P4 版本变了不清除：提示后重读，再点才清；最早一版清完回到更新的版本', async () => {
    const saved = await agent(p => { shotsOf(p)[5].framing = '合成：并发新版本'; }, '并发的一次修改');
    await button('这一版看过了').click();
    await expect(panel()).toContainText('这次没有清除'); assert.ok((await api(base + '/pending')).pending_versions.some(v => v.version === first.revision));
    await button('这一版看过了').click();
    await expect(panel()).toContainText('场景地点写错了'); await expect(panel()).not.toContainText('这几镜不够有镜头感');
    assert.deepEqual((await api(base + '/pending')).pending_versions.map(v => v.version), [saved.revision, third.revision]);
  });

  await check('P5 全部未看：各版原话都在；场景和整体设置能单独看过', async () => {
    await agent(p => { shotsOf(p)[5].framing = '合成：第二次修改'; }, '同一镜再改一次');
    await open(); await button(/全部未看/).click();
    const card = panel().getByRole('article').filter({ hasText: '并发的一次修改' });
    await expect(card).toContainText('同一镜再改一次'); await expect(card).toContainText('合成：第二次修改'); await shot('p5-all-unseen');
    const scene = panel().getByRole('article').filter({ hasText: '场景设置' }); await expect(scene).toContainText('合成：新地点');
    await scene.getByRole('button', { name: '看过了' }).click(); await expect(scene).toHaveCount(0);
    const doc = panel().getByRole('article').filter({ hasText: '分镜整体设置' }); await doc.getByRole('button', { name: '看过了' }).click(); await expect(doc).toHaveCount(0);
    const left = await api(base + '/pending'); assert.equal(left.pending_document_count, 0); assert.equal(left.pending_count, 1);
  });

  await check('P6 改动记录展开一版：同样的显示，噪音单独可查，不清待看', async () => {
    const pendingBefore = await api(base + '/pending');
    await tab('改动记录').click(); await page.getByRole('button', { name: `展开 V${second.revision} 的改动` }).click();
    const row = page.locator('.sb-history-expanded'); await expect(row.locator('.sb-change')).toContainText('删除了镜 20'); await expect(row.getByText(/另有 \d+ 处不算修改/)).toBeVisible();
    assert.equal(await page.locator('.sb-table-scroll').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, '改动记录表格横向溢出'); await row.locator('summary').click(); await expect(row.locator('.sb-history-noise li').first()).toContainText('全片镜号'); await shot('p6-log-expanded');
    assert.deepEqual(await api(base + '/pending'), pendingBefore);
  });

  await check('P7 窄屏 390 和深色主题：版本视图没有横向溢出', async () => {
    await page.evaluate(() => localStorage.setItem('shiguang.theme', 'dark')); await open(); await page.getByRole('button', { name: '关闭镜头详情' }).click(); await page.getByRole('button', { name: '隐藏场景目录' }).click(); await page.setViewportSize({ width: 390, height: 844 });   // 窄屏下镜头详情和场景目录都盖在内容上，先关掉
    await button('这一版看过了').scrollIntoViewIfNeeded(); await button('这一版看过了').click({ trial: true }); assert.equal(await panel().evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, '待看面板横向溢出'); await shot('p7-narrow-dark');
    await page.evaluate(() => localStorage.setItem('shiguang.theme', 'forest')); await page.setViewportSize({ width: 1440, height: 900 });
  });

  await check('P8 全部看过后显示空状态', async () => {
    await open(); await button('全部看过').click(); await expect(panel()).toContainText('没有待看的修改'); await expect(button(/全部未看 · 0 处/)).toBeVisible(); await expect(tab(/待看的修改/).locator('b')).toHaveCount(0);
  });

  assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
  passed = true; console.log('ALL PASS storyboard-pending-version-ui');
} finally {
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); const r = await Promise.race([exited, new Promise(x => setTimeout(() => x('timeout'), 20000))]); if (r === 'timeout') { console.log('服务没有在 20 秒内退出'); passed = false; } }
  if (passed && !logs.includes('APPLICATION_CLOSED_KNOWN')) { console.log('没有正常关闭'); passed = false; }
  await fs.rm(temp, { recursive: true, force: true });
  if (!passed) { console.log(logs.slice(-1500)); process.exitCode = 1; }
}
