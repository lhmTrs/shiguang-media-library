// STORYBOARD-CHANGE-LOG v1 前后端组合界面测试：真实本地服务（全新合成库，历史表随新库建立）+ 无头浏览器，不拦截接口。
// 覆盖：可选列与可读性、阅读模式、只有保存才写库、未保存高亮、保存/放弃/留着、agent 保存后的待看与分类、改动记录、
// 查看旧版本/对比/恢复、AI 优先冲突、大改确认、窄屏与六主题截图。不连真实库、4317、平台或模型。
// 用法：npm run build && node tests/storyboard-change-log-ui.mjs（CREATIVE_TEST_EVIDENCE=目录 时保存截图）
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { selectProjectInBar } from './helpers/path-bar.mjs';
import { syntheticSource } from './helpers/storyboard-fixture.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'storyboard-change-log-ui-')));
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
/** 模拟 agent 保存：读当前分镜，改一处，带原话和分类保存。 */
async function agentSave(projectId, edit, reason = '把镜2改成近景，突出笔记本', category = 'prompt_wrong') {
  const cur = await api('/storyboard/projects/' + projectId); const p = structuredClone(cur.project); edit(p);
  return api('/storyboard/projects/' + projectId, { project: p, expected_revision: cur.revision, change: { author: 'agent', reason_category: category, reason_text: reason }, request_id: randomUUID() }, 'PUT');
}
const shotOf = (p, n) => p.scenes.flatMap(s => s.shots)[n - 1];

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const s = await fetch(origin + '/api/session'); cookie = s.headers.get('set-cookie').split(';')[0]; token = (await s.json()).token;
  const main = await api('/projects', { name: '合成 · 改动记录' }), small = await api('/projects', { name: '合成 · 大改' });
  const example = JSON.parse(await fs.readFile(path.join(root, 'server/storyboard/example.json'), 'utf8'));
  await api('/storyboard/projects/' + main.id + '/initialize', { request_id: randomUUID(), source: example, expected_revision: null, filename: '示例.json', timing: 'duration' });
  await api('/storyboard/projects/' + small.id + '/initialize', { request_id: randomUUID(), source: syntheticSource(), expected_revision: null, filename: '合成.json', timing: 'duration' });
  // 首次导入会把所有镜头记为待看（后端规则）；这里模拟用户已看过导入结果，后面只看 agent 的修改。
  for (const id of [main.id, small.id]) { const pend = await api('/storyboard/projects/' + id + '/pending'); await api('/storyboard/projects/' + id + '/pending/clear', { through_version: pend.current_revision, all: true }); }

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => { localStorage.setItem('shiguang.refreshSeconds', '0'); });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { const u = new URL(r.url()); if (u.origin !== origin && !['data:', 'blob:'].includes(u.protocol)) foreign.push(r.url()); });
  const puts = []; page.on('request', r => { if (r.method() === 'PUT' && /\/api\/storyboard\/projects\/[^/]+$/.test(new URL(r.url()).pathname)) puts.push(r.postDataJSON()); });
  const open = async id => { await page.goto(origin + '/?r=' + Date.now() + '#/storyboards'); await selectProjectInBar(page, id); await expect(page.getByRole('table', { name: '可编辑分镜表' })).toBeVisible({ timeout: 15000 }); };
  const status = () => page.getByTestId('save-status');
  const saveBtn = () => page.getByRole('button', { name: /保存项目/ });
  const tab = name => page.getByRole('group', { name: '分镜视图' }).getByRole('button', { name });
  const cell = (n, field) => page.getByLabel('镜' + n + field, { exact: true });

  await check('S1 默认只显示景别、画面与动作、时长；界面设置勾选「摄影机设计」后出现，刷新后仍在', async () => {
    await open(main.id);
    const heads = await page.getByRole('table', { name: '可编辑分镜表' }).locator('thead th').allTextContents();
    assert.deepEqual(heads.map(t => t.trim()).filter(Boolean), ['镜号', '景别与角度', '画面与人物动作', '时长']);
    await page.getByRole('button', { name: '分镜界面设置' }).click();
    await page.getByRole('group', { name: /编辑表格显示的列/ }).getByLabel('摄影机设计').check();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('columnheader', { name: '摄影机设计' })).toBeVisible();
    await open(main.id); await expect(page.getByRole('columnheader', { name: '摄影机设计' })).toBeVisible();
    await shot('s1-columns');
  });

  await check('S2 只有点保存才写库：改格子后不自动保存；格子浅黄底、镜号黄点、状态写「1 个镜头、1 处未保存」', async () => {
    puts.length = 0;
    await cell('02', '画面与人物动作').fill('合成：小林停住，低头看笔记本上的字。'); await cell('03', '景别与角度').click();
    await page.waitForTimeout(2000); assert.equal(puts.length, 0, '不应自动保存');
    await expect(status()).toContainText('1 个镜头、1 处未保存');
    await expect(page.locator('label.sb-unsaved').filter({ has: cell('02', '画面与人物动作') })).toHaveCount(1);
    await expect(page.getByTestId('shot-row-02').getByRole('img', { name: '这一镜有未保存的修改' })).toBeVisible();
    await shot('s2-unsaved');
  });

  await check('S3 离开分镜页：「留着」不走；「放弃」回到已保存内容；「保存」写库后再离开', async () => {
    await page.getByRole('button', { name: '生成视频' }).first().click();
    await expect(page.getByTestId('leave-stay')).toBeVisible(); await shot('s3-leave');
    await page.getByTestId('leave-stay').click(); await expect(page.getByRole('table', { name: '可编辑分镜表' })).toBeVisible();
    await page.getByRole('button', { name: '生成视频' }).first().click(); await page.getByTestId('leave-discard').click();
    await expect(page.getByRole('region', { name: '项目生成视频' })).toBeVisible();
    await page.getByRole('button', { name: '分镜设计' }).first().click(); await expect(cell('02', '画面与人物动作')).not.toHaveValue(/低头看笔记本/);
    await cell('02', '画面与人物动作').fill('合成：小林低头看字。'); await cell('03', '景别与角度').click();
    puts.length = 0; await page.getByRole('button', { name: '生成视频' }).first().click(); await page.getByTestId('leave-save').click();
    await expect(page.getByRole('region', { name: '项目生成视频' })).toBeVisible();
    assert.equal(puts.length, 1); assert.deepEqual(puts[0].change, { author: 'user' }); assert.ok(puts[0].request_id);
    const v = await api('/storyboard/projects/' + main.id + '/versions?limit=1'); assert.equal(v.items[0].author_kind, 'user'); assert.equal(v.items[0].reason_text, '用户手动保存');
  });

  await check('S4 agent 保存后：待看数量、镜号「待看」、卡片写原话和分类；改分类；「看过了」只清这一镜', async () => {
    await agentSave(main.id, p => { shotOf(p, 2).framing = '近景，略俯拍'; shotOf(p, 5).action = '合成：小林合上本子。'; });
    await open(main.id);
    await expect(tab(/待看的修改/).locator('b')).toHaveText('2');
    await expect(page.getByTestId('shot-row-02').getByText('待看')).toBeVisible();
    await tab(/待看的修改/).click();
    const card = page.getByRole('article').filter({ hasText: '镜 02' });
    await expect(card).toContainText('Codex'); await expect(card).toContainText('提示词不对'); await expect(card).toContainText('把镜2改成近景');
    await expect(card).toContainText('近景，略俯拍'); await shot('s4-pending');
    await card.getByRole('combobox', { name: /修改原因分类/ }).selectOption('shot_feel');
    await expect(page.getByRole('article').filter({ hasText: '镜 02' })).toContainText('追求镜头感');
    await page.getByRole('article').filter({ hasText: '镜 02' }).getByRole('button', { name: '看过了' }).click();
    await expect(page.getByRole('article').filter({ hasText: '镜 02' })).toHaveCount(0);
    await expect(page.getByRole('article').filter({ hasText: '镜 05' })).toHaveCount(1);
    const pend = await api('/storyboard/projects/' + main.id + '/pending'); assert.equal(pend.pending_count, 1);
  });

  await check('S5 改动记录：每次保存一行（谁改的、原因）；查看旧版本只读，和当前对比；恢复成新版本且历史保留', async () => {
    await tab('改动记录').click();
    const table = page.locator('.sb-history-table');
    await expect(table).toContainText('用户手动保存'); await expect(table).toContainText('追求镜头感'); await shot('s5-log');
    const before = await api('/storyboard/projects/' + main.id + '/versions?limit=100');
    const target = before.items.find(m => m.author_kind === 'import'); assert.ok(target, '应有导入版本');
    await table.locator('tr').filter({ hasText: 'V' + target.version + ' ' }).or(table.locator('tr').filter({ has: page.getByText('V' + target.version, { exact: true }) })).first().getByRole('button', { name: '查看' }).click();
    const dlg = page.getByRole('dialog', { name: '分镜阅读模式' });
    await expect(dlg).toContainText('正在查看 V' + target.version + '（只读）');
    await dlg.getByRole('button', { name: /和当前版本对比/ }).click(); await expect(dlg.locator('.sb-reading-diff').first()).toBeVisible(); await shot('s5-old-version');
    page.once('dialog', d => d.accept()); await dlg.getByRole('button', { name: '恢复这一版' }).click();
    await expect(dlg).toHaveCount(0);
    const after = await api('/storyboard/projects/' + main.id + '/versions?limit=100');
    assert.equal(after.items[0].author_kind, 'restore'); assert.equal(after.items[0].restored_from, target.version); assert.equal(after.total, before.total + 1);
    await expect(cell('02', '画面与人物动作')).toHaveValue(/翻开笔记本/);
  });

  await check('S6 AI 优先：页面有未保存修改时 agent 先保存，点保存会载入最新并提示放弃了几处', async () => {
    await cell('04', '景别与角度').fill('合成：用户没保存的修改'); await cell('03', '景别与角度').click();
    await agentSave(main.id, p => { shotOf(p, 4).framing = 'agent 的特写'; }, '镜4改成特写', 'shot_feel');
    await saveBtn().click();
    await expect(page.getByText('Codex 刚保存了新版本')).toBeVisible();
    await expect(cell('04', '景别与角度')).toHaveValue('agent 的特写'); await expect(status()).not.toContainText('未保存');
    await shot('s6-ai-first');
  });

  await check('S7 阅读模式：整屏只读、镜头之间有衔接、Esc 退出；点镜号回到编辑并定位', async () => {
    await page.getByRole('button', { name: '阅读模式' }).click();
    const dlg = page.getByRole('dialog', { name: '分镜阅读模式' });
    await expect(dlg.locator('.sb-reading-cut').first()).toContainText('01 → 02'); await shot('s7-reading');
    await page.keyboard.press('Escape'); await expect(dlg).toHaveCount(0);
    await page.getByRole('button', { name: '阅读模式' }).click(); await dlg.locator('.sb-reading-num').nth(6).click();
    await expect(dlg).toHaveCount(0); await expect(page.getByTestId('shot-row-07')).toHaveClass(/sb-active-row/);
  });

  await check('S8 大改确认：一次改动超过一半先弹确认；「先不保存」不写库，「确定保存」后记录只记摘要', async () => {
    await open(small.id); puts.length = 0;
    await cell('01', '画面与人物动作').fill('长'.repeat(1500)); await cell('01', '景别与角度').click();
    await saveBtn().click(); await expect(page.getByTestId('big-cancel')).toBeVisible(); await shot('s8-big');
    await page.getByTestId('big-cancel').click(); assert.equal(puts.length, 0); await expect(status()).toContainText('未保存');
    await saveBtn().click(); await page.getByTestId('big-save').click(); await expect(status()).toContainText('已保存');
    const v = await api('/storyboard/projects/' + small.id + '/versions?limit=1'); assert.equal(v.items[0].summary_only, true);
  });

  await check('S9 窄屏 390 与六个主题：阅读模式和改动记录正常显示、无横向溢出（截图留证）', async () => {
    await open(main.id);
    await page.setViewportSize({ width: 390, height: 844 }); await page.getByRole('button', { name: '阅读模式' }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '阅读模式横向溢出'); await shot('s9-reading-390');
    await page.keyboard.press('Escape'); await page.setViewportSize({ width: 1440, height: 900 });
    for (const theme of ['forest', 'dark', 'midnight', 'sepia', 'graphite', 'ocean']) {
      await page.evaluate(t => localStorage.setItem('shiguang.theme', t), theme); await open(main.id);
      await tab(/待看的修改/).click(); await expect(page.locator('.sb-history')).toBeVisible();
      await shot('s9-theme-' + theme);
    }
    await page.evaluate(() => localStorage.setItem('shiguang.theme', 'forest'));
  });

  assert.deepEqual(errors, []); assert.deepEqual(foreign, []);
  passed = true; console.log('ALL PASS storyboard-change-log-ui');
} finally {
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); const r = await Promise.race([exited, new Promise(x => setTimeout(() => x('timeout'), 20000))]); if (r === 'timeout') { console.log('服务没有在 20 秒内退出'); passed = false; child.kill('SIGKILL'); await exited; } }
  if (passed && !logs.includes('APPLICATION_CLOSED_KNOWN')) { console.log('没有正常关闭'); passed = false; }
  await fs.rm(temp, { recursive: true, force: true });
  if (!passed) { console.log(logs.slice(-2500)); process.exitCode = 1; }
}
