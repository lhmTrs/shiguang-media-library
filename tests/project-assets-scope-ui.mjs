// 第二期 P2a 第 1 步：项目资产页按作用域读取。
// 页内「第 N 集 ｜ 全剧 ｜ 公共人物库」、卡片来源标记、继承资产只读、全剧视图；项目未归剧 / 后端没有作用域接口时保持原有行为。
// 真实本地服务 + 合成剧集；作用域接口按 SERIES-P2a 合同 v1 的形状用测试替身返回（后端分支合入前）。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { projectInBar } from './helpers/path-bar.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-assets-scope-'));
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [], seen = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal'), CODEX_HOME: path.join(temp, 'no-codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_CODEX_AUTOCONNECT: '0', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); assert.ok(response.ok, p + ' ' + JSON.stringify(data)); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const rid = () => crypto.randomUUID();
const work = () => page.getByRole('region', { name: '项目资产库' });
const list = () => work().locator('section.ca-gallery').first();
const cards = () => list().locator('.ca-card:not(.ca-card-add) strong');
const card = name => list().locator('.ca-card').filter({ hasText: name });
const settled = async names => { await expect(list()).toHaveAttribute('aria-busy', 'false'); await expect(cards()).toHaveText(names); };
const nav = name => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click();
const scopeSwitch = () => work().getByRole('group', { name: '看哪里的资产' });
const switchTo = name => scopeSwitch().getByRole('button', { name, exact: true }).click();
async function pickEpisode(id) { await projectInBar(page).getByRole('navigation', { name: '当前项目' }).getByRole('button').last().click(); await projectInBar(page).locator(`.ppb-option[data-target-project="${id}"]`).click(); await expect(projectInBar(page)).toHaveAttribute('data-project', id); }

// —— 作用域接口替身（合同 v1 形状）——
const fake = { mode: 'contract', ctx: {}, shared: [], local: {} };
const caps = (own) => ({ edit_base: own, create_override: !own, append: !own, promote: own, archive: own });
const item = (asset, owner) => ({ asset, owner, capabilities: caps(owner.type === 'project'), effective: {}, context_token: 'ctx-token', cover: null, look_count: asset.looks?.length ?? 0 });
async function routeScoped(route) {
  const url = new URL(route.request().url()); seen.push(url.pathname);
  if (fake.mode === 'missing') return route.fulfill({ status: 404, json: { error: '旧版后端没有这个接口' } });
  if (fake.mode === 'html') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html><body>旧版后端把未知路径交给前端页面</body></html>' });
  const ctxMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/asset-context$/);
  if (ctxMatch) { const c = fake.ctx[ctxMatch[1]]; return c ? route.fulfill({ json: c }) : route.fulfill({ status: 404, json: { error: '项目不存在' } }); }
  const m = url.pathname.match(/^\/api\/project-assets\/scopes\/(series|season|episode)\/([^/]+)\/assets(?:\/([^/]+))?$/);
  if (!m) return route.continue();
  const [, type, id, assetId] = m, kind = url.searchParams.get('kind') || 'character';
  const shared = fake.shared.filter(x => x.asset.kind === kind), local = type === 'episode' ? (fake.local[id] || []).filter(x => x.asset.kind === kind) : [];
  const all = [...shared, ...local];
  if (assetId) { const hit = [...fake.shared, ...(fake.local[id] || [])].find(x => x.asset.id === assetId); return hit ? route.fulfill({ json: hit }) : route.fulfill({ status: 404, json: { error: '不在这个作用域' } }); }
  return route.fulfill({ json: { scope: { type, id }, context_token: 'ctx-token', total: all.length, page: 1, items: all } });
}

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  const s = await api('/project-series', { name: '穿越计', software: 'jianying', request_id: rid() });
  const q = await api(`/project-series/${s.id}/seasons`, { request_id: rid() });
  const eps = []; for (let i = 1; i <= 2; i++) eps.push((await api(`/project-series/${s.id}/episodes`, { season_id: q.id, expected_episode_no: i, request_id: rid() })).project);
  const solo = await api('/projects', { name: '独立短片' });
  // 真实资产：李四当作全剧共享（替身里 project_id 置空、归属剧），卖油郎是第 1 集自有；独立短片有自己的人物
  const lisi = await api('/project-assets/assets', { project_id: eps[0].id, kind: 'character', name: '李四' });
  const seller = await api('/project-assets/assets', { project_id: eps[0].id, kind: 'character', name: '卖油郎' });
  await api('/project-assets/assets', { project_id: solo.id, kind: 'character', name: '短片主角' });
  const seriesOwner = { type: 'series', id: s.id, name: s.name };
  fake.shared = [item({ ...lisi, project_id: null }, seriesOwner)];
  fake.local[eps[0].id] = [item(seller, { type: 'project', id: eps[0].id, name: eps[0].name })];
  for (const e of eps) fake.ctx[e.id] = { project: { id: e.id, name: e.name }, series: { id: s.id, name: s.name }, season: { id: q.id, name: '第 1 季' }, membership_revision: 1, context_token: 'ctx-' + e.id };
  fake.ctx[solo.id] = { project: { id: solo.id, name: solo.name }, series: null, season: null, membership_revision: 1, context_token: 'ctx-solo' };

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => { try { localStorage.setItem('shiguang.refreshSeconds', '0'); } catch {} });
  await context.route(u => /\/api\/projects\/[^/]+\/asset-context$/.test(new URL(u).pathname) || new URL(u).pathname.startsWith('/api/project-assets/scopes/'), routeScoped);
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/#/projects'); await expect(projectInBar(page)).toHaveAttribute('data-project', /./);
  await pickEpisode(eps[0].id); await nav('项目资产');

  await check('集视图：页内三段切换；列表 = 全剧共享 + 本集自有，卡片标来源', async () => {
    await expect(scopeSwitch().getByRole('button')).toHaveText([/第1集|穿越计/, '全剧', '公共人物库']);
    await expect(scopeSwitch().getByRole('button').first()).toHaveAttribute('aria-pressed', 'true');
    await settled(['李四', '卖油郎']);
    await expect(card('李四').locator('.ca-owner-src')).toHaveText('全剧'); await expect(card('卖油郎').locator('.ca-owner-src')).toHaveText('只在本集');
    assert.ok(seen.some(p => p === `/api/project-assets/scopes/episode/${eps[0].id}/assets`), '集视图应走作用域列表接口');
  });

  await check('继承自全剧的资产在集视图只读并说明原因；本集自有资产照常可编辑', async () => {
    await card('李四').click(); await expect(work().locator('.ca-name-input')).toHaveValue('李四');
    await expect(work().locator('.ca-scope-lock')).toContainText('全剧共享的资产'); await expect(work().locator('.ca-name-input')).toBeDisabled();
    await expect(work().getByLabel('基础信息', { exact: true })).toBeDisabled();
    await card('卖油郎').click(); await expect(work().locator('.ca-name-input')).toHaveValue('卖油郎');
    await expect(work().locator('.ca-scope-lock')).toHaveCount(0); await expect(work().locator('.ca-name-input')).toBeEnabled();
    await work().getByLabel('基础信息', { exact: true }).fill('本集自有的资料'); await work().getByRole('button', { name: '保存资料', exact: true }).click();
    await expect(work().getByRole('button', { name: '保存资料', exact: true })).toBeDisabled();
    assert.equal((await api('/project-assets/assets/' + seller.id)).base_info, '本集自有的资料');
  });

  await check('切到「全剧」：顶栏不变，提示条说明，只列共享资产，暂不能新建', async () => {
    await switchTo('全剧'); await expect(scopeSwitch().getByRole('button', { name: '全剧', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(work().locator('.ca-series-note')).toContainText('正在看「穿越计」全剧的资产');
    await settled(['李四']); await expect(projectInBar(page)).toHaveAttribute('data-project', eps[0].id);
    assert.ok(seen.some(p => p === `/api/project-assets/scopes/series/${s.id}/assets`), '全剧视图应走剧作用域');
    await expect(work().getByRole('button', { name: /^新建/ }).first()).toBeDisabled();
    await card('李四').click(); await expect(work().locator('.ca-scope-lock')).toContainText('全剧资料的编辑会在下一步接入');
    // 回到集视图；去公共人物库再回来也回到集视图
    await switchTo('第1集').catch(() => scopeSwitch().getByRole('button').first().click()); await settled(['李四', '卖油郎']);
    await switchTo('全剧'); await settled(['李四']); await switchTo('公共人物库'); await expect(work().locator('.ca-series-note')).toHaveCount(0);
    await scopeSwitch().getByRole('button').first().click(); await settled(['李四', '卖油郎']);
  });

  await check('换集：回到「第 N 集」视图并读新的作用域', async () => {
    await switchTo('全剧'); await settled(['李四']);
    await page.getByRole('button', { name: '下一集：第2集' }).click(); await expect(projectInBar(page)).toHaveAttribute('data-project', eps[1].id);
    await expect(scopeSwitch().getByRole('button').first()).toHaveAttribute('aria-pressed', 'true'); await settled(['李四']);
    assert.ok(seen.some(p => p === `/api/project-assets/scopes/episode/${eps[1].id}/assets`));
  });

  await check('项目不在任何剧里：没有「全剧」，按原接口读取', async () => {
    const before = seen.length;
    await projectInBar(page).getByRole('navigation', { name: '当前项目' }).getByRole('button').first().click();
    await projectInBar(page).locator(`.ppb-option[data-target-project="${solo.id}"]`).first().click(); await expect(projectInBar(page)).toHaveAttribute('data-project', solo.id);
    await settled(['短片主角']); await expect(scopeSwitch().getByRole('button', { name: '全剧', exact: true })).toHaveCount(0);
    await expect(list().locator('.ca-owner-src')).toHaveCount(0);
    assert.ok(!seen.slice(before).some(p => p.startsWith('/api/project-assets/scopes/')), '未归剧时不走作用域列表');
  });

  await check('后端还没有作用域接口（404 或回网页本身）：保持原有行为，不报错', async () => {
    fake.mode = 'missing'; await pickEpisodeFromSeries();
    await expect(list()).toHaveAttribute('aria-busy', 'false'); await expect.poll(async () => (await cards().allTextContents()).sort()).toEqual(['卖油郎', '李四']); // 原接口按最近修改排序
    await expect(scopeSwitch().getByRole('button', { name: '全剧', exact: true })).toHaveCount(0);
    await expect(list().locator('.ca-owner-src')).toHaveCount(0); await expect(work().getByRole('alert')).toHaveCount(0);
    // 旧后端对未知路径回网页本身（200 + HTML）：同样保持原样、不提示错误
    fake.mode = 'html'; await page.reload(); await nav('项目资产');
    await expect(list()).toHaveAttribute('aria-busy', 'false'); await expect.poll(async () => (await cards().allTextContents()).sort()).toEqual(['卖油郎', '李四']);
    await expect(scopeSwitch().getByRole('button', { name: '全剧', exact: true })).toHaveCount(0); await expect(work().getByRole('alert')).toHaveCount(0);
    fake.mode = 'contract';
  });
  async function pickEpisodeFromSeries() {
    await projectInBar(page).getByRole('navigation', { name: '当前项目' }).getByRole('button').first().click();
    await projectInBar(page).locator('.ppb-option').filter({ hasText: '穿越计' }).first().click();
    await expect(projectInBar(page)).toHaveAttribute('data-project', new RegExp(eps.map(e => e.id).join('|')));
    if (await projectInBar(page).getAttribute('data-project') !== eps[0].id) await page.getByRole('button', { name: '上一集：第1集' }).click();
    await expect(projectInBar(page)).toHaveAttribute('data-project', eps[0].id);
  }

  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-2000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'creative-assets-scope-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); let timer; if (await Promise.race([exited, new Promise(r => timer = setTimeout(() => r('timeout'), 10000))]) === 'timeout') { child.kill('SIGKILL'); await exited; } clearTimeout(timer);
  await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
