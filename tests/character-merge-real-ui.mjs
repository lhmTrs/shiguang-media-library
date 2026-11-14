// 合并同名人物（合同 v1 · B）前后端组合：真实本地服务，不替身任何接口。
// 合成剧「穿越计」两集各有一个「李四」（各两个造型，其中「常服」同名），走发现 → 合并 → 来源与版本里撤销 → 新建撞名提示。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { projectInBar, selectProjectInBar } from './helpers/path-bar.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'character-merge-real-'));
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [], failures = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal'), CODEX_HOME: path.join(temp, 'no-codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_CODEX_AUTOCONNECT: '0', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); if (!response.ok) throw Object.assign(Error(data.error || response.status), { data }); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const rid = () => crypto.randomUUID();
const nav = name => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click();
const work = () => page.getByRole('region', { name: '项目资产库' });
const scopeSwitch = () => work().getByRole('group', { name: '看哪里的资产' });
const evidence = process.env.CREATIVE_TEST_EVIDENCE;
const shot = async name => { if (evidence) { await fs.mkdir(evidence, { recursive: true }); await page.screenshot({ path: path.join(evidence, name + '.png') }); } };

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  const S = await api('/project-series', { name: '穿越计', software: 'jianying', request_id: rid() });
  const q = await api(`/project-series/${S.id}/seasons`, { request_id: rid() });
  const eps = []; for (let i = 1; i <= 2; i++) eps.push((await api(`/project-series/${S.id}/episodes`, { season_id: q.id, expected_episode_no: i, request_id: rid() })).project);
  // 两集各一个「李四」，各两个造型，「常服」同名
  const person = async (project, looks, info) => {
    let a = await api('/project-assets/assets', { project_id: project.id, kind: 'character', name: '李四' });
    const ids = looks.map(() => crypto.randomUUID());
    a = await api('/project-assets/assets/' + a.id, { asset: { ...a, base_info: info, default_look_id: ids[0], looks: looks.map((name, i) => ({ id: ids[i], name, description: '', tags: [], default_image_id: null, archived_at: null })) }, expected_revision: a.revision }, 'PUT');
    return a;
  };
  const A = await person(eps[0], ['常服', '夜行服'], '卖油郎的结拜兄弟，嘴硬心软');
  const B = await person(eps[1], ['常服', '官服'], '第二集换了身份，混进县衙');
  await api('/project-assets/assets', { project_id: eps[0].id, kind: 'character', name: '王五' });
  const groups = () => api(`/project-series/${S.id}/character-merge-groups`);
  const seriesPeople = async () => (await api(`/project-assets/scopes/series/${S.id}/assets?kind=character`)).items;
  assert.equal((await groups()).summary.group_count, 1, '夹具：应有一组同名人物');

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => { try { localStorage.setItem('shiguang.refreshSeconds', '0'); } catch {} });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  page.on('response', r => { const p = new URL(r.url()).pathname; if (/character-merge|names\/check|\/scopes\//.test(p) && r.status() >= 500) failures.push(r.status() + ' ' + p); });
  await page.goto(origin + '/#/all'); await expect(page.locator('.ppb').first()).toHaveAttribute('data-project', /./);
  await selectProjectInBar(page, eps[0].id); await nav('项目资产');

  await check('B0 真实：第 1 集的李四卡片提示「第 2 集也有一个」，菜单有合并入口', async () => {
    const card = work().locator('.ca-card-wrap').filter({ hasText: '李四' }).first();
    await expect(card.locator('.cm-card-hint')).toHaveText('第 2 集也有一个「李四」');
    await card.hover(); await card.getByRole('button', { name: '李四的更多操作' }).click();
    await expect(page.getByRole('menu', { name: '李四的操作' }).getByRole('menuitem', { name: '合并同名人物…' })).toBeVisible();
    await page.keyboard.press('Escape');
  });

  await check('B1 真实：全剧提示条 → 选主体（第 1 集）→ 合并后的样子 → 同名「常服」默认都保留并加集名 → 确认；剧里变成一个全剧「李四」，四个造型', async () => {
    await scopeSwitch().getByRole('button', { name: '全剧', exact: true }).click();
    const banner = work().locator('.cm-banner'); await expect(banner).toContainText('1 个人物');
    await banner.getByRole('button', { name: '逐个合并' }).click();
    const dlg = page.getByRole('dialog', { name: '合并「李四」' });
    await expect(dlg.getByRole('radio', { name: /第 1 集的「李四」/ })).toBeChecked(); await shot('1-pick');
    await dlg.getByRole('button', { name: '看合并后的样子' }).click(); await expect(dlg).toContainText('合并后的样子');
    await expect(dlg).toContainText('第二集换了身份'); await expect(dlg).toContainText('1 个同名造型'); await shot('2-impact');
    await dlg.getByRole('button', { name: '处理 1 个同名造型' }).click();
    await expect(dlg.getByRole('radio', { name: /都保留/ })).toBeChecked(); await expect(dlg.getByLabel('新造型名称')).toHaveValue(/常服.*2/); await shot('3-issues');
    await dlg.getByRole('button', { name: '确认合并' }).click(); await expect(dlg).toHaveCount(0);
    await expect(work().locator('.cm-done')).toContainText('已合并「李四」：现在是全剧共享人物，4 个造型。'); await shot('4-done');
    assert.equal((await groups()).summary.group_count, 0, '合并后不应再有同名组');
    const li = (await seriesPeople()).find(x => x.asset.name === '李四'); assert.ok(li, '全剧应有李四');
    assert.equal(li.asset.id, A.id, '主体保留所选的原 ID'); assert.equal(li.asset.looks.filter(l => !l.archived_at).length, 4, '两份的造型都并进来');
    assert.equal(li.asset.base_info, '卖油郎的结拜兄弟，嘴硬心软', '资料用主体的');
    // 复验：在全剧打开合并后的李四改资料不保存，再点撤销 → 先要求处理修改，不发起撤销（撤销会让李四回到集里）
    await work().locator('.ca-card').filter({ hasText: '李四' }).first().click(); await expect(work().locator('.ca-name-input')).toHaveValue('李四');
    const info = work().getByLabel('基础信息', { exact: true }); await info.fill('全剧李四的草稿');
    await work().locator('.cm-done').getByRole('button', { name: '撤销' }).click();
    await expect(work().getByRole('alert').first()).toContainText('请先保存或放弃'); await expect(page.getByRole('dialog', { name: /撤销合并/ })).toHaveCount(0);
    page.once('dialog', d => d.accept()); await work().getByRole('button', { name: '放弃修改' }).click(); await expect(info).toHaveValue('卖油郎的结拜兄弟，嘴硬心软');
    assert.equal((await groups()).summary.group_count, 0, '没有撤销');
  });

  await check('B3 真实：来源与版本里有合并记录，「撤销这次合并…」恢复成两份', async () => {
    await work().locator('.ca-card').filter({ hasText: '李四' }).first().click(); await expect(work().locator('.ca-name-input')).toHaveValue('李四');
    await work().getByRole('button', { name: '资料操作' }).click(); await work().getByRole('menuitem', { name: /来源与版本/ }).click();
    const hist = page.getByRole('dialog', { name: '来源与版本' }); await hist.getByRole('button', { name: '撤销这次合并…' }).click();
    const undo = page.getByRole('dialog', { name: '撤销合并「李四」' }); await expect(undo).toContainText('恢复'); await shot('5-undo');
    await undo.getByRole('button', { name: '撤销合并' }).click(); await expect(undo).toHaveCount(0);
    await expect(work()).toContainText('已撤销合并「李四」');
    assert.equal((await groups()).summary.group_count, 1, '撤销后恢复成一组两份');
    assert.ok(!(await seriesPeople()).some(x => x.asset.name === '李四'), '撤销后全剧不再有李四');
  });

  await check('B0 真实：全剧新建「李四」→ 提示两集已各有一个，「合并这几个」打开合并浮窗，没有新建', async () => {
    await work().getByRole('button', { name: /^新建/ }).first().click(); const dlg = page.getByRole('dialog', { name: '新建资产' });
    await dlg.getByLabel('新资产名称').fill('李四'); await dlg.getByRole('button', { name: '创建并编辑' }).click();
    await expect(dlg.locator('.cm-create-ask')).toContainText('第 1 集、第 2 集已经各有一个「李四」'); await shot('6-create-merge');
    await dlg.getByRole('button', { name: '合并这几个「李四」…' }).click(); await expect(dlg).toHaveCount(0);
    const merge = page.getByRole('dialog', { name: '合并「李四」' }); await expect(merge).toBeVisible(); await merge.getByRole('button', { name: '取消' }).click();
    assert.ok(!(await seriesPeople()).some(x => x.asset.name === '李四'), '提示期间不应新建');
  });

  await check('B0 真实：第 2 集新建「王五」→ 只有第 1 季第 1 集有 → 提示到那一集提升到全剧（带季号），只给「换个名字」', async () => {
    // 顶栏的「下一集」切到第 2 集（当前在第 1 集，顶栏第一个下拉列的是剧）
    const next = projectInBar(page).getByRole('button', { name: /^下一集/ }); await next.focus(); await page.keyboard.press('Enter');
    await expect(projectInBar(page)).toHaveAttribute('data-project', eps[1].id); await expect(scopeSwitch().getByRole('button').first()).toHaveAttribute('aria-pressed', 'true');
    await work().getByRole('button', { name: /^新建/ }).first().click(); const dlg = page.getByRole('dialog', { name: '新建资产' });
    await dlg.getByLabel('新资产名称').fill('王五'); await dlg.getByRole('button', { name: '创建并编辑' }).click();
    const ask = dlg.locator('.cm-create-ask'); await expect(ask).toContainText('第 1 季第 1 集已经有一个「王五」'); await expect(ask).toContainText('到第 1 季第 1 集把它提升到全剧'); // 只有一份时总带季号（组合验收 R3）
    await expect(dlg.getByRole('button', { name: /合并这几个/ })).toHaveCount(0); await shot('7-create-promote');
    await dlg.getByRole('button', { name: '换个名字' }).click(); await expect(ask).toHaveCount(0);
  });

  await check('收口 真实：确认前别处改了人物 → 服务端已落定的拒绝（request_settled）→ 不留待核对、按最新情况重新核对；按原编号查到 rejected 回执；再确认成功', async () => {
    const confirmIds = []; const onReq = r => { if (/character-merges\/confirm$/.test(new URL(r.url()).pathname)) confirmIds.push(r.postDataJSON().request_id); }; page.on('request', onReq);
    const create = page.getByRole('dialog', { name: '新建资产' }); if (await create.count()) { await create.locator('footer').getByRole('button', { name: /关闭|取消/ }).click(); await expect(create).toHaveCount(0); } // 上一项停在新建表单
    await scopeSwitch().getByRole('button', { name: '全剧', exact: true }).click();
    await work().locator('.cm-banner').getByRole('button', { name: '逐个合并' }).click();
    const dlg = page.getByRole('dialog', { name: '合并「李四」' }); await dlg.getByRole('button', { name: '看合并后的样子' }).click(); await dlg.getByRole('button', { name: '处理 1 个同名造型' }).click();
    // 别处改了第 2 集的李四：预览凭证过期
    const cur = (await api(`/project-assets/scopes/episode/${eps[1].id}/assets/${B.id}`)).asset;
    await api('/project-assets/assets/' + B.id, { asset: { ...cur, base_info: cur.base_info + '（别处改过）' }, expected_revision: cur.revision }, 'PUT');
    await dlg.getByRole('button', { name: '确认合并' }).click();
    await expect(dlg.getByRole('status').filter({ hasText: '已按最新情况重新核对' })).toBeVisible(); await expect(work().locator('.cm-pending')).toHaveCount(0);
    const rejected = await api(`/project-series/${S.id}/character-merge-requests/${confirmIds[0]}`);
    assert.equal(rejected.found, true); assert.equal(rejected.result.status, 'rejected'); assert.equal(rejected.result.code, 'CHARACTER_MERGE_STALE');
    await dlg.getByRole('button', { name: /处理 1 个同名造型|确认合并/ }).first().click();
    if (await dlg.getByRole('button', { name: '确认合并' }).count()) await dlg.getByRole('button', { name: '确认合并' }).click();
    await expect(dlg).toHaveCount(0); await expect(work().locator('.cm-done')).toContainText('已合并「李四」');
    assert.notEqual(confirmIds.at(-1), confirmIds[0], '被拒后重新确认用新编号'); page.off('request', onReq);
  });

  assert.deepEqual(failures, [], '不应有服务端 5xx');
  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-2500)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'character-merge-real-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); let timer; if (await Promise.race([exited, new Promise(r => timer = setTimeout(() => r('timeout'), 10000))]) === 'timeout') { child.kill('SIGKILL'); await exited; } clearTimeout(timer);
  await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
