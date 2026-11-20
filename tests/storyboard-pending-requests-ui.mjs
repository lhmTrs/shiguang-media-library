// 分镜页待看接口的请求次数：打开页面、切到待看、切到改动记录、回到编辑，每一步只读必要的次数。
// 真实本地服务（全新合成库）+ 无头浏览器，不拦截接口。不连真实库、4317、平台或模型。
// 用法：npm run build && node tests/storyboard-pending-requests-ui.mjs
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'storyboard-pending-requests-ui-')));
const s0 = net.createServer(); await new Promise(r => s0.listen(0, '127.0.0.1', r)); const port = s0.address().port; await new Promise(r => s0.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const errors = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production', MEDIA_CONTAINER: '0', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'p'), CODEX_HOME: path.join(temp, 'c'), MEDIA_UPDREAM_QUEUE_DIR: path.join(temp, 'no-queue'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_CODEX_AUTOCONNECT: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', (code, signal) => r({ code, signal })));
async function api(p, body, method) {
  const r = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json(); if (!r.ok) throw Object.assign(Error(p + ' ' + r.status + ' ' + JSON.stringify(d).slice(0, 300)), { status: r.status, data: d }); return d;
}
async function check(name, fn) { await fn(); console.log('PASS ' + name); }
const shotsOf = p => p.scenes.flatMap(s => s.shots);

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const s = await fetch(origin + '/api/session'); cookie = s.headers.get('set-cookie').split(';')[0]; token = (await s.json()).token;
  const main = await api('/projects', { name: '合成 · 待看请求次数' }), base = '/storyboard/projects/' + main.id;
  const example = JSON.parse(await fs.readFile(path.join(root, 'server/storyboard/example.json'), 'utf8'));
  await api(base + '/initialize', { request_id: randomUUID(), source: example, expected_revision: null, filename: '示例.json', timing: 'duration' });
  const cur = await api(base), p = structuredClone(cur.project);
  shotsOf(p)[1].framing = '合成：近景'; shotsOf(p)[2].camera = '合成：推近';
  await api(base, { project: p, expected_revision: cur.revision, change: { author: 'agent', reason_category: 'shot_feel', reason_text: '合成：镜头感' }, request_id: randomUUID() }, 'PUT');
  assert.equal((await api(base + '/pending')).pending_count, 2);

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => { localStorage.setItem('shiguang.refreshSeconds', '0'); });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  let pending = 0;
  page.on('request', r => { const u = new URL(r.url()); if (r.method() === 'GET' && u.pathname.endsWith('/storyboard/projects/' + main.id + '/pending')) pending++; });
  const tab = name => page.getByRole('group', { name: '分镜视图' }).getByRole('button', { name });
  const settle = () => page.waitForTimeout(1500);
  const step = async (label, expected) => { await settle(); const n = pending; pending = 0; console.log(`${label}: 待看请求 ${n} 次`); assert.equal(n, expected, `${label} 应读 ${expected} 次待看，实际 ${n} 次`); };

  await check('打开分镜页只读一次待看，镜头上有待看标记、页签角标正确', async () => {
    await page.goto(origin + '/?r=' + Date.now() + '#/storyboards'); await selectProjectInBar(page, main.id);
    await expect(page.getByRole('table', { name: '可编辑分镜表' })).toBeVisible({ timeout: 15000 });
    await expect(tab(/待看的修改/).locator('b')).toHaveText('2');
    await expect(page.locator('.sb-pending-chip')).toHaveCount(2);
    await step('打开页面', 1);
  });
  await check('切到待看只由面板读一次', async () => {
    await tab(/待看的修改/).click(); await expect(page.getByLabel('待看的修改', { exact: true })).toBeVisible();
    await step('切到待看', 1);
  });
  await check('在待看里看过一处后，离开待看重读一次，镜头标记随之更新', async () => {
    const panel = page.getByLabel('待看的修改', { exact: true });
    await panel.getByRole('button', { name: '全部未看 · 2 处' }).click();
    await panel.getByRole('button', { name: '看过了' }).first().click();
    await expect(tab(/待看的修改/).locator('b')).toHaveText('1');
    pending = 0;
    await tab('编辑').click(); await expect(page.getByRole('table', { name: '可编辑分镜表' })).toBeVisible();
    await expect(page.locator('.sb-pending-chip')).toHaveCount(1);
    await step('待看→编辑', 1);
  });
  await check('编辑和改动记录之间来回不读待看', async () => {
    await tab('改动记录').click(); await step('编辑→改动记录', 0);
    await tab('编辑').click(); await step('改动记录→编辑', 0);
  });

  assert.deepEqual(errors, []);
  passed = true; console.log('ALL PASS storyboard-pending-requests-ui');
} finally {
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); const r = await Promise.race([exited, new Promise(x => setTimeout(() => x('timeout'), 20000))]); if (r === 'timeout') { console.log('服务没有在 20 秒内退出'); passed = false; } }
  if (passed && !logs.includes('APPLICATION_CLOSED_KNOWN')) { console.log('没有正常关闭'); passed = false; }
  await fs.rm(temp, { recursive: true, force: true });
  if (!passed) { console.log(logs.slice(-1500)); process.exitCode = 1; }
}
