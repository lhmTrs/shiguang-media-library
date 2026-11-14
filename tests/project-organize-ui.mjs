// 「整理旧项目」批量归组（SERIES-P1 原型 ④）：一次 POST /project-series/organize，服务端一个事务；真实本地服务 + 合成项目；不接入真实素材库。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-organize-'));
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false, organizeMode = 'pass', releaseHeld = null; const checks = [], errors = [], organizeBodies = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal'), CODEX_HOME: path.join(temp, 'no-codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_CODEX_AUTOCONNECT: '0', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); assert.ok(response.ok, p + ' ' + JSON.stringify(data)); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const rid = () => crypto.randomUUID();
const pf = () => page.locator('.pf');
const dlg = () => page.getByRole('dialog', { name: '整理旧项目' });
// 项目页会进到当前项目所在那一层（#89）；「整理旧项目」在最外层才有，先回最外层（已在最外层时没有面包屑）
const toRoot = async () => { await pf().waitFor(); const up = pf().getByRole('navigation', { name: '位置' }).getByRole('button', { name: '项目' }); if (await up.count()) await up.click(); };
const submit = () => dlg().getByRole('button', { name: /^归组 \d+ 个项目$/ });
const no = name => dlg().getByLabel(name + '的集号');
const seriesNames = async () => (await api('/project-series')).map(s => s.name).sort();
const ungroupedNames = async () => (await api('/projects')).filter(p => !p.series_id).map(p => p.name).sort();

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  for (const name of ['赤贫农夫养家计_1', '赤贫农夫养家计_54', '玫瑰的婚姻1-1', '玫瑰的婚姻2', '玫瑰的婚姻3', '温情短剧', '此恨2']) await api('/projects', { name, software: name.startsWith('玫瑰') ? 'resolve' : 'jianying' });
  const hen = await api('/project-series', { name: '此恨', software: 'jianying', request_id: rid() });
  await api(`/project-series/${hen.id}/seasons`, { request_id: rid() });
  for (const n of [1, 2]) await api(`/project-series/${hen.id}/episodes`, { season_id: null, expected_episode_no: n, request_id: rid() });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1480, height: 1000 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  // organizeMode：pass 照常；lost-after = 服务端已执行但回应丢失；lost-before = 客户端失去回应、服务端此时没收到；hold = 挂起直到放行。
  await page.route(url => url.pathname === '/api/project-series/organize', async route => {
    organizeBodies.push(JSON.parse(route.request().postData() || '{}'));
    if (organizeMode === 'lost-after') { organizeMode = 'pass'; await route.fetch(); return route.abort('connectionreset'); }
    if (organizeMode === 'lost-before') { organizeMode = 'pass'; return route.abort('connectionreset'); }
    if (organizeMode === 'hold') { organizeMode = 'pass'; await new Promise(r => { releaseHeld = r; }); }
    return route.fallback();
  });
  await page.goto(origin + '/#/projects'); await expect(pf()).toBeVisible();

  await check('按名字给出 3 组建议：玫瑰的婚姻（1-1 编号不确定）、赤贫农夫养家计（1、54）、已有剧「此恨」；温情短剧不在其中', async () => {
    await toRoot(); await pf().getByRole('button', { name: '整理旧项目' }).click(); await expect(dlg()).toBeVisible();
    await expect(dlg().locator('.pf-og')).toHaveCount(3);
    await expect(dlg().getByLabel('玫瑰的婚姻的剧名')).toHaveValue('玫瑰的婚姻'); await expect(dlg().getByLabel('赤贫农夫养家计的剧名')).toHaveValue('赤贫农夫养家计');
    await expect(dlg().locator('.pf-og').filter({ hasText: '此恨2' })).toContainText('已有剧');
    await expect(dlg().getByText('编号不确定，请核对')).toHaveCount(1); await expect(no('玫瑰的婚姻1-1')).toHaveValue('1');
    await expect(no('赤贫农夫养家计_54')).toHaveValue('54'); await expect(no('此恨2')).toHaveValue('2');
    await expect(dlg()).not.toContainText('温情短剧');
    await expect(dlg().getByLabel('此恨的放入位置')).toHaveValue('root');
    await expect(dlg()).toContainText('将新建 2 部剧，归组 6 个项目');
  });

  await check('本组重号、剧名和已有剧重名时不能提交；改回后可以提交', async () => {
    await no('玫瑰的婚姻3').fill('2'); await expect(dlg().getByText('和本组另一项重号')).toHaveCount(2); await expect(submit()).toBeDisabled();
    await no('玫瑰的婚姻3').fill('3'); await expect(submit()).toBeEnabled();
    await dlg().getByLabel('玫瑰的婚姻的剧名').fill('此恨'); await expect(dlg().getByText('已有同名的剧')).toBeVisible(); await expect(submit()).toBeDisabled();
    await dlg().getByLabel('此恨的剧名').fill('玫瑰的婚姻'); await expect(submit()).toBeEnabled();
  });

  await check('撞号时一个都不写：此恨剧里已有第 2 集 → 服务端整批回退，没有新建任何剧，项目仍未分组', async () => {
    await submit().click();
    await expect(dlg().getByRole('alert')).toContainText('整批都没有写入'); await expect(dlg().getByText('第 2 集已被占用')).toBeVisible();
    assert.deepEqual(await seriesNames(), ['此恨']);
    assert.deepEqual(await ungroupedNames(), ['此恨2', '温情短剧', '玫瑰的婚姻1-1', '玫瑰的婚姻2', '玫瑰的婚姻3', '赤贫农夫养家计_1', '赤贫农夫养家计_54'].sort());
  });

  await check('第二组在服务端冲突时整批回退：打开整理后有人另建了「赤贫农夫养家计」→ 提交得到冲突，零新剧、零归属变化；改名后一次成功', async () => {
    await no('此恨2').fill('5');
    await api('/project-series', { name: '赤贫农夫养家计', software: 'jianying', request_id: rid() });
    await submit().click();
    await expect(dlg().getByRole('alert')).toContainText('整批都没有写入');
    await expect(dlg().locator('.pf-og').filter({ hasText: '赤贫农夫养家计_54' })).toContainText('已有同名的剧');
    assert.deepEqual(await seriesNames(), ['此恨', '赤贫农夫养家计']);
    assert.deepEqual(await ungroupedNames(), ['此恨2', '温情短剧', '玫瑰的婚姻1-1', '玫瑰的婚姻2', '玫瑰的婚姻3', '赤贫农夫养家计_1', '赤贫农夫养家计_54'].sort());
    const first = organizeBodies.at(-1)?.request_id; // 合入维度统一后端后，冲突在整理预览里就拦下，可能根本没发出归组
    await dlg().getByLabel('赤贫农夫养家计的剧名').fill('赤贫农夫养家计（重剪）'); await submit().click();
    await expect(dlg()).toHaveCount(0); await expect(page.locator('.pf-toast')).toContainText('已新建 2 部剧、归组 6 个项目');
    assert.notEqual(organizeBodies.at(-1).request_id, first, '改过内容后应换新的请求编号');
    assert.deepEqual(await seriesNames(), ['此恨', '玫瑰的婚姻', '赤贫农夫养家计', '赤贫农夫养家计（重剪）']);
  });

  await check('归组结果：集号按确认的来、项目名一个都没改；根目录只剩温情短剧，再打开整理显示没有可归组的项目', async () => {
    const projects = await api('/projects'), series = await api('/project-series'), by = n => projects.find(p => p.name === n), sid = n => series.find(s => s.name === n).id;
    assert.deepEqual([by('赤贫农夫养家计_1').episode_no, by('赤贫农夫养家计_54').episode_no], [1, 54]); assert.equal(by('赤贫农夫养家计_54').series_id, sid('赤贫农夫养家计（重剪）'));
    assert.deepEqual(['玫瑰的婚姻1-1', '玫瑰的婚姻2', '玫瑰的婚姻3'].map(n => [by(n).series_id === sid('玫瑰的婚姻'), by(n).season_id, by(n).episode_no]), [[true, null, 1], [true, null, 2], [true, null, 3]]);
    assert.deepEqual([by('此恨2').series_id === sid('此恨'), by('此恨2').season_id, by('此恨2').episode_no], [true, null, 5]);
    assert.equal(series.find(s => s.name === '玫瑰的婚姻').software, 'resolve');
    await expect(pf().getByRole('button', { name: /^打开剧 玫瑰的婚姻$/ })).toContainText('3 集');
    await expect(pf().getByRole('region', { name: '未分组的项目' }).getByRole('button', { name: /^温情短剧/ })).toBeVisible();
    await toRoot(); await pf().getByRole('button', { name: '整理旧项目' }).click(); await expect(dlg()).toContainText('没找到能归到同一部剧的项目');
    await dlg().getByRole('button', { name: '关闭', exact: true }).click(); await expect(dlg()).toHaveCount(0);
  });

  await check('回应丢失：服务端已归组但回应没回来 → 按原编号查到结果直接完成，不重复写入', async () => {
    for (const name of ['番外篇_1', '番外篇_2']) await api('/projects', { name });
    await page.reload(); await expect(pf()).toBeVisible();
    await toRoot(); await pf().getByRole('button', { name: '整理旧项目' }).click(); await expect(dlg().locator('.pf-og')).toHaveCount(1);
    organizeMode = 'lost-after'; const before = organizeBodies.length; await submit().click();
    await expect(dlg()).toHaveCount(0); await expect(page.locator('.pf-toast')).toContainText('已新建 1 部剧、归组 2 个项目');
    assert.equal(organizeBodies.length, before + 1, '只发了一次归组请求');
    assert.equal((await seriesNames()).filter(n => n === '番外篇').length, 1);
  });

  await check('FE5-R1 反例：提交进行中与结果待核对时，剧名和放入位置都锁住；界面始终显示原内容，重发用原编号原内容、只写一次', async () => {
    for (const name of ['花絮_1', '花絮_2']) await api('/projects', { name });
    await page.reload(); await expect(pf()).toBeVisible();
    await toRoot(); await pf().getByRole('button', { name: '整理旧项目' }).click(); await expect(dlg().locator('.pf-og')).toHaveCount(1);
    organizeMode = 'hold'; await submit().click();
    await expect(dlg().getByRole('button', { name: '归组中…' })).toBeVisible();
    await expect(dlg().getByLabel('花絮的剧名')).toBeDisabled(); await expect(no('花絮_1')).toBeDisabled();
    await expect.poll(() => typeof releaseHeld).toBe('function'); // 提交会先做维度预览，等整理请求真的发出并被扣住再放行
    releaseHeld(); releaseHeld = null; await expect(dlg()).toHaveCount(0);
    assert.equal((await seriesNames()).filter(n => n === '花絮').length, 1);
    for (const name of ['幕后_1', '幕后_2']) await api('/projects', { name });
    await page.reload(); await expect(pf()).toBeVisible();
    await toRoot(); await pf().getByRole('button', { name: '整理旧项目' }).click(); await expect(dlg().locator('.pf-og')).toHaveCount(1);
    organizeMode = 'lost-before'; await submit().click();
    await expect(dlg().getByRole('alert')).toContainText('尚未查到成功回执，结果待核对');
    const nameBox = dlg().getByLabel('幕后的剧名'); await expect(nameBox).toBeDisabled(); await expect(no('幕后_1')).toBeDisabled();
    await nameBox.fill('幕后-界面已改', { force: true }).catch(() => {}); await expect(nameBox).toHaveValue('幕后');
    const original = organizeBodies.at(-1);
    await dlg().getByRole('button', { name: '用原请求重新提交' }).click();
    await expect(dlg()).toHaveCount(0); await expect(page.locator('.pf-toast')).toContainText('已新建 1 部剧、归组 2 个项目');
    assert.deepEqual(organizeBodies.at(-1), original, '重发的编号和内容与原请求一致');
    const names = await seriesNames(); assert.equal(names.filter(n => n === '幕后').length, 1); assert.ok(!names.includes('幕后-界面已改'));
  });

  await check('FE5-R2 反例：回应丢失时查不到回执，不说成“没写”；原请求随后才到达服务端并成功 → 「重新核对」拿到成功回执，放入位置锁住', async () => {
    await api('/projects', { name: '此恨3' });
    await page.reload(); await expect(pf()).toBeVisible();
    await toRoot(); await pf().getByRole('button', { name: '整理旧项目' }).click(); await expect(dlg().locator('.pf-og')).toHaveCount(1);
    await expect(dlg().getByLabel('此恨的放入位置')).toBeEnabled();
    organizeMode = 'lost-before'; await submit().click();
    const alert = dlg().getByRole('alert');
    await expect(alert).toContainText('尚未查到成功回执，结果待核对'); await expect(alert).not.toContainText('什么都没写');
    await expect(dlg().getByLabel('此恨的放入位置')).toBeDisabled();
    const original = organizeBodies.at(-1);
    await api('/project-series/organize', original);
    const sent = organizeBodies.length;
    await dlg().getByRole('button', { name: '重新核对' }).click();
    await expect(dlg()).toHaveCount(0); await expect(page.locator('.pf-toast')).toContainText('归组 1 个项目');
    assert.equal(organizeBodies.length, sent, '核对不应再发归组请求');
    const p = (await api('/projects')).find(x => x.name === '此恨3'); assert.ok(p.series_id); assert.equal(p.episode_no, 3);
  });

  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-3000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'creative-organize-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); await exited; await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
