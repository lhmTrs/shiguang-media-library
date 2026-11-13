// 人物属性维度剧内统一（合同 v1 · A）的前端检查：A1 集里的维度入口、A2 一键统一、A3 归组 / 挪集 / 整理时的维度对应。
// 真实本地服务 + 合成剧集；合同新增的字段和接口（后端开发中）用 page.route 按合同 v1 的形状替身，
// 真实接口照常执行（写请求转发前去掉合同新增的字段）。只验证前端行为，不代表后端已接通。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { selectProjectInBar } from './helpers/path-bar.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'series-attr-align-'));
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal'), CODEX_HOME: path.join(temp, 'no-codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_CODEX_AUTOCONNECT: '0', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); if (!response.ok) throw Object.assign(Error(data.error || response.status), { data }); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const rid = () => crypto.randomUUID();
const nav = name => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click();
const work = () => page.getByRole('region', { name: '项目资产库' });
const pf = () => page.locator('.pf');
const dim = (id, name, neg, pos) => ({ id, name, negative_label: neg, positive_label: pos, neutral_label: '中', criterion: '' });
const impact = people => ({ project_count: 1, people, archived_people: 0, scored_cells: people, manual_clear_cells: 0 });
const strip = body => { const { config_token, attribute_preview_token, attribute_choices, ...rest } = body; return rest; };

// ---- 合同 v1 替身状态 ----
const fake = { aligned: false, alignStatus: 'pending', alignMode: 'identical', previews: [], confirms: [], dropConfirmOnce: false, receipts: {}, patches: [], moves: [], movePreviews: [], movePlan: null, organizes: [], organizePreviews: [], organizePlan: null };
let S, eps = [], solo;
function alignmentPreview(choices = []) {
  const episodes = eps.map((p, i) => ({ project_id: p.id, project_name: p.name, membership_revision: 1, comparison: fake.alignMode === 'diff' && i === 1 ? 'needs_review' : 'identical', automatic: [],
    decisions: fake.alignMode === 'diff' && i === 1 ? [{ item_id: 'it-fame', source_dimension_id: 'd-fame', source_dimension: dim('d-fame', '财运', '破财', '发财'), reason: 'missing_in_series',
      allowed_actions: ['retain_legacy', 'add_to_series', 'map_existing'], eligible_targets: [dim('d-wealth', '财力', '贫', '富')], suggested_choice: { item_id: 'it-fame', action: 'retain_legacy' }, impact: impact(2) }] : [],
    target_only_dimensions: [] }));
  const chosen = fake.alignMode === 'diff' ? (choices.length ? choices : [{ item_id: 'it-fame', action: 'retain_legacy' }]) : [];
  const adding = chosen.some(c => c.action === 'add_to_series');
  return { series_id: S.id, alignment_revision: 3, ready: true, preview_token: 'pv-' + fake.previews.length, episodes, choices: chosen,
    series_changes: { added: adding ? [{ item_ids: ['it-fame'], dimension: dim('d-fame', '财运', '破财', '发财'), impact: impact(12) }] : [], dimension_count_before: 6, dimension_count_after: adding ? 7 : 6, min: 3, max: 8 },
    total_impact: { project_count: 2, people: 2, archived_people: 0, scored_cells: 54, manual_clear_cells: 0 }, blockers: [] };
}
const withRealPlan = async (previewPath, previewBody, body) => { const real = strip(body); const pv = await api(previewPath, previewBody);
  const plan = pv.attribute_plan; if (plan?.preview_token) Object.assign(real, { attribute_preview_token: plan.preview_token, attribute_choices: plan.choices }); return real; };
async function installMocks() {
  // A1：生效配置。已统一时集入口返回全剧作用域与配置凭证
  await page.route(u => /^\/api\/project-assets\/projects\/[^/]+\/attribute-config$/.test(new URL(u).pathname), async route => {
    if (route.request().method() !== 'GET' || !fake.aligned) return route.fallback();
    const res = await route.fetch(); const data = await res.json(); fake.realToken = data.config_token; // 合入的后端会校验凭证，转发保存时换回真实凭证
    return route.fulfill({ json: { ...data, series_id: S.id, config_scope: 'series', alignment_status: 'aligned', config_editable: false, config_token: 'cfg-tok' } });
  });
  await page.route(u => /^\/api\/project-assets\/assets\/[^/]+\/attributes$/.test(new URL(u).pathname), async route => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const body = route.request().postDataJSON(); fake.patches.push(body); const real = strip(body); if (fake.realToken) real.config_token = fake.realToken; return route.continue({ postData: JSON.stringify(real) });
  });
  // A2：剧对齐
  await page.route(u => /^\/api\/project-series\/[^/]+\/attribute-alignment(\/preview|\/confirm)?$/.test(new URL(u).pathname), async route => {
    const p = new URL(route.request().url()).pathname;
    if (p.endsWith('/preview')) { const body = route.request().postDataJSON(); fake.previews.push(body); return route.fulfill({ json: alignmentPreview(body.choices ?? []) }); }
    if (p.endsWith('/confirm')) {
      const body = route.request().postDataJSON(); fake.confirms.push(body);
      const receipt = { request_id: body.request_id, kind: 'attribute_alignment', series_id: S.id, alignment_status: 'aligned', alignment_revision: 4, config_revision: 5, history_id: 'h1', episodes_updated: 2, scores_remapped: 52, scores_retained_in_history: fake.alignMode === 'diff' ? 2 : 0, can_undo: false };
      fake.receipts[body.request_id] = receipt; fake.alignStatus = 'aligned';
      if (fake.dropConfirmOnce) { fake.dropConfirmOnce = false; return route.abort('connectionreset'); }
      return route.fulfill({ json: receipt });
    }
    return route.fulfill({ json: { series_id: S.id, status: fake.alignStatus, alignment_revision: 3, episode_count: 2 } });
  });
  await page.route(u => /^\/api\/project-series\/requests\/[^/]+$/.test(new URL(u).pathname), async route => {
    const id = new URL(route.request().url()).pathname.split('/').pop(); const r = fake.receipts[id];
    return r ? route.fulfill({ json: { found: true, result: r } }) : route.fallback();
  });
  // A3：移动 / 整理的维度计划
  await page.route(u => new URL(u).pathname === '/api/project-series/moves/preview', async route => {
    const body = route.request().postDataJSON(); fake.movePreviews.push(body);
    const res = await route.fetch({ postData: JSON.stringify(strip(body)) }); const data = await res.json();
    if (!res.ok() || !fake.movePlan) return route.fulfill({ status: res.status(), json: data });
    return route.fulfill({ json: { ...data, attribute_plan: fake.movePlan(body) } });
  });
  await page.route(u => new URL(u).pathname === '/api/project-series/moves', async route => {
    const body = route.request().postDataJSON(); fake.moves.push(body);
    const res = await route.fetch({ postData: JSON.stringify(await withRealPlan('/project-series/moves/preview', { target: body.target, items: body.items }, body)) }); const data = await res.json();
    return route.fulfill({ status: res.status(), json: res.ok() && body.attribute_preview_token ? { ...data, can_undo: false, undo_disabled_reason: 'ATTRIBUTE_CONFIGURATION_CHANGED' } : data });
  });
  await page.route(u => new URL(u).pathname === '/api/project-series/organize/preview', async route => {
    const body = route.request().postDataJSON(); fake.organizePreviews.push(body);
    return route.fulfill({ json: { ready: true, conflicts: [], attribute_plan: fake.organizePlan(body) } });
  });
  await page.route(u => new URL(u).pathname === '/api/project-series/organize', async route => {
    const body = route.request().postDataJSON(); fake.organizes.push(body); return route.continue({ postData: JSON.stringify(await withRealPlan('/project-series/organize/preview', { groups: body.groups }, body)) });
  });
}

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  S = await api('/project-series', { name: '穿越计', software: 'jianying', request_id: rid() });
  const q = await api(`/project-series/${S.id}/seasons`, { request_id: rid() });
  for (let i = 1; i <= 2; i++) eps.push((await api(`/project-series/${S.id}/episodes`, { season_id: q.id, expected_episode_no: i, request_id: rid() })).project);
  solo = await api('/projects', { name: '独立短片' });
  for (const n of ['新剧_1', '新剧_2']) await api('/projects', { name: n });
  await api('/project-assets/assets', { project_id: eps[0].id, kind: 'character', name: '卖油郎' });

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => { try { localStorage.setItem('shiguang.refreshSeconds', '0'); } catch {} });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await installMocks();
  await page.goto(origin + '/#/all'); await expect(page.locator('.ppb').first()).toHaveAttribute('data-project', /./);
  await selectProjectInBar(page, eps[0].id); await nav('项目资产');

  await check('A2 一致：全剧视图提示「还没统一」→ 浮窗列出各集一致 → 确认统一，提交原凭证，提示条消失', async () => {
    await work().getByRole('group', { name: '看哪里的资产' }).getByRole('button', { name: '全剧', exact: true }).click();
    const banner = work().locator('.aa-banner'); await expect(banner).toContainText('还没统一');
    await banner.getByRole('button', { name: '查看并统一' }).click();
    const dlg = page.getByRole('dialog', { name: '统一「穿越计」的人物属性维度' }); await expect(dlg).toContainText('2 集的维度和全剧完全一致');
    await dlg.getByRole('button', { name: '确认统一' }).click(); await expect(dlg).toHaveCount(0);
    const c = fake.confirms.at(-1); assert.equal(c.preview_token, 'pv-1'); assert.deepEqual(c.choices, []); assert.match(c.request_id, /^[0-9a-f-]{36}$/);
    await expect(banner).toHaveCount(0); await expect(work()).toContainText('已统一：2 集改用全剧的维度');
  });

  await check('A2 有差异：逐项决定（改选会重新预览）；确认回应丢失时按原请求号查回执，不重发', async () => {
    fake.alignStatus = 'pending'; fake.alignMode = 'diff'; fake.dropConfirmOnce = true; const before = fake.confirms.length;
    await work().getByRole('group', { name: '看哪里的资产' }).getByRole('button').first().click();
    await work().getByRole('group', { name: '看哪里的资产' }).getByRole('button', { name: '全剧', exact: true }).click();
    await work().locator('.aa-banner').getByRole('button', { name: '查看并统一' }).click();
    const dlg = page.getByRole('dialog', { name: '统一「穿越计」的人物属性维度' });
    await expect(dlg).toContainText('需要你决定 · 1 个'); await expect(dlg).toContainText('全剧没有这个维度');
    await expect(dlg.getByRole('radio', { name: /保留为旧评分/ })).toBeChecked();
    await dlg.getByRole('radio', { name: /含义一样，对应到/ }).check();
    await expect.poll(() => fake.previews.at(-1)?.choices?.[0]?.action).toBe('map_existing');
    assert.equal(fake.previews.at(-1).choices[0].target_dimension_id, 'd-wealth');
    await dlg.getByRole('button', { name: '确认统一' }).click(); await expect(dlg).toHaveCount(0);
    assert.equal(fake.confirms.length - before, 1, '回应丢失后不应换新编号重发'); assert.equal(fake.confirms.at(-1).choices[0].action, 'map_existing');
    await expect(work()).toContainText('2 格保留在历史里');
  });

  await check('A1 已统一的集：属性区说明由全剧统一；维度设置不可在集里改，「去全剧设置」切到全剧并打开全剧维度；集里打分带配置凭证', async () => {
    fake.aligned = true;
    await work().getByRole('group', { name: '看哪里的资产' }).getByRole('button').first().click();
    await work().locator('.ca-card').filter({ hasText: '卖油郎' }).first().click(); await expect(work().locator('.ca-name-input')).toHaveValue('卖油郎');
    const attrs = work().getByRole('region', { name: '人物属性' });
    await expect(attrs).toContainText('这一集的维度由全剧统一设置');
    await attrs.getByRole('button', { name: '编辑' }).click(); await attrs.locator('input[type=number]').first().fill('15');
    await attrs.getByRole('button', { name: '保存属性' }).click(); await expect(attrs.getByRole('button', { name: '编辑' })).toBeVisible();
    assert.equal(fake.patches.at(-1).config_token, 'cfg-tok');
    await attrs.getByRole('button', { name: '维度在全剧设置…' }).click();
    const managed = page.getByRole('dialog', { name: '人物属性维度' }); await expect(managed).toContainText('由全剧统一设置');
    await managed.getByRole('button', { name: '去全剧设置' }).click();
    await expect(work().getByRole('group', { name: '看哪里的资产' }).getByRole('button', { name: '全剧', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const seriesDlg = page.getByRole('dialog', { name: '人物属性维度' }); await expect(seriesDlg).toContainText('全剧「穿越计」');
    await seriesDlg.getByRole('button', { name: '关闭维度设置' }).click();
    await work().getByRole('group', { name: '看哪里的资产' }).getByRole('button').first().click(); fake.aligned = false;
  });

  await check('A3 放进剧有要决定的维度：先弹维度对应，确认后移动带凭证和选择，提示不能一键撤销', async () => {
    fake.movePlan = body => ({ preview_token: 'mv-' + fake.movePreviews.length, can_undo: false, choices: body.attribute_choices ?? [{ group_id: 'move', decisions: [{ item_id: 'it-x', action: 'retain_legacy' }] }],
      groups: [{ group_id: 'move', mode: 'map_to_series', target_series_id: S.id, alignment: { ...alignmentPreview(), episodes: [{ project_id: solo.id, project_name: '独立短片', membership_revision: 0, comparison: 'needs_review', automatic: [],
        decisions: [{ item_id: 'it-x', source_dimension_id: 'x', source_dimension: dim('x', '名望', '无名', '显赫'), reason: 'missing_in_series', allowed_actions: ['retain_legacy', 'add_to_series'], eligible_targets: [], suggested_choice: { item_id: 'it-x', action: 'retain_legacy' }, impact: impact(1) }], target_only_dimensions: [] }] } }] });
    await nav('项目'); await pf().getByRole('navigation', { name: '位置' }).getByRole('button', { name: '项目' }).click().catch(() => {});
    await pf().getByRole('button', { name: /^独立短片/ }).first().click({ button: 'right' }); await page.getByRole('menuitem', { name: '放进剧…' }).click();
    await page.getByRole('dialog', { name: '移到…' }).getByRole('button', { name: '移动' }).click();
    const nums = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: '保存' }) }); await nums.getByRole('button', { name: '保存' }).click();
    const map = page.getByRole('dialog', { name: /放进「穿越计」/ }); await expect(map).toContainText('名望'); await expect(map).toContainText('不能一键撤销');
    await map.getByRole('button', { name: '确认放进剧' }).click(); await expect(map).toHaveCount(0);
    const m = fake.moves.at(-1); assert.ok(m.attribute_preview_token?.startsWith('mv-')); assert.deepEqual(m.attribute_choices[0].decisions[0], { item_id: 'it-x', action: 'retain_legacy' });
    const toast = pf().locator('.pf-toast'); await expect(toast).toContainText('人物属性维度已改用这部剧的'); await expect(toast.getByRole('button', { name: '撤销' })).toHaveCount(0);
  });

  await check('A3 移出剧不用决定：直接带凭证移动，提示已复制一份全剧维度', async () => {
    fake.movePlan = () => ({ preview_token: 'mv-out', can_undo: false, choices: [], groups: [{ group_id: 'move', mode: 'copy_to_standalone', target_series_id: null, exit_projects: [{ project_id: eps[1].id, source_series_id: S.id, config_revision: 5 }] }] });
    await pf().getByRole('navigation', { name: '位置' }).getByRole('button', { name: '项目' }).click().catch(() => {});
    await pf().getByRole('button', { name: '打开剧 穿越计' }).click(); await pf().getByRole('button', { name: /^打开 第 1 季/ }).click();
    await pf().getByRole('button', { name: /第 2 集/ }).first().click({ button: 'right' }); await page.getByRole('menuitem', { name: '移到…' }).click();
    const d = page.getByRole('dialog', { name: '移到…' }); await d.getByLabel('目标位置').selectOption('out'); await d.getByRole('button', { name: '移动' }).click();
    await expect(page.getByRole('dialog', { name: /移出剧/ })).toHaveCount(0);
    await expect.poll(() => fake.moves.at(-1)?.attribute_preview_token).toBe('mv-out');
    await expect(pf().locator('.pf-toast')).toContainText('已复制一份全剧维度给移出的集');
  });

  await check('A3 整理旧项目：新剧要选维度基准时先核对（改选重新预览），确认后整批带凭证提交', async () => {
    fake.organizePlan = body => { const g = body.groups.find(x => x.target.new_series); const items = g.items.map(i => i.project_id);
      return { preview_token: 'og-' + fake.organizePreviews.length, can_undo: false, choices: body.attribute_choices ?? [{ group_id: g.group_id, baseline: { kind: 'default' }, decisions: [] }],
        groups: [{ group_id: g.group_id, mode: 'map_to_series', target_series_id: null, baseline_options: [{ kind: 'default' }, ...items.map(id => ({ kind: 'episode', project_id: id }))], baseline: { kind: 'default' } }] }; };
    await pf().getByRole('navigation', { name: '位置' }).getByRole('button', { name: '项目' }).click().catch(() => {});
    await pf().getByRole('button', { name: '整理旧项目' }).click();
    const dlg = page.getByRole('dialog', { name: '整理旧项目' }); await expect(dlg).toContainText('新剧');
    await dlg.getByRole('button', { name: /^归组 \d+ 个项目/ }).click();
    const base = dlg.getByLabel('新剧的维度基准'); await expect(base).toBeVisible();
    await base.selectOption({ label: '复制「新剧_1」的维度' });
    await expect.poll(() => fake.organizePreviews.at(-1)?.attribute_choices?.[0]?.baseline?.kind).toBe('episode');
    await dlg.getByRole('button', { name: /^归组 \d+ 个项目/ }).click(); await expect(dlg).toHaveCount(0);
    const o = fake.organizes.at(-1); assert.ok(o.attribute_preview_token?.startsWith('og-')); assert.equal(o.attribute_choices[0].baseline.kind, 'episode');
  });

  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-2500)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'series-attr-align-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); let timer; if (await Promise.race([exited, new Promise(r => timer = setTimeout(() => r('timeout'), 10000))]) === 'timeout') { child.kill('SIGKILL'); await exited; } clearTimeout(timer);
  await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
