// 合并同名人物（合同 v1 · B）的前端检查：发现、卡片提示与菜单入口、三步合并浮窗、结果不明时保留原请求、
// 依赖过期重新核对、全剧人物锁定为主体、撤销（合并后又改过要确认）、新建撞名的改进提示。
// 真实本地服务 + 合成剧集与人物；B 的接口（后端开发中）用 page.route 按合同 v1 的形状替身。只验证前端行为。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { selectProjectInBar } from './helpers/path-bar.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'character-merge-'));
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal'), CODEX_HOME: path.join(temp, 'no-codex'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_CODEX_AUTOCONNECT: '0', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); if (!response.ok) throw Object.assign(Error(data.error || response.status), { data }); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const rid = () => crypto.randomUUID();
const nav = name => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name, exact: true }).click();
const work = () => page.getByRole('region', { name: '项目资产库' });
const evidence = process.env.CREATIVE_TEST_EVIDENCE;
const shot = async name => { if (evidence) { await fs.mkdir(evidence, { recursive: true }); await page.screenshot({ path: path.join(evidence, name + '.png') }); } };
const scopeSwitch = () => work().getByRole('group', { name: '看哪里的资产' });

let S, eps = [], A, B;
const ep = (i, project) => ({ project_id: project.id, project_name: project.name, episode_no: i, season_id: 'q1', season_no: 1, season_label: '第 1 季' });
const member = (id, owner, episode, extra = {}) => ({ asset_id: id, asset_revision: 1, owner_type: owner, owner_id: owner === 'series' ? S.id : episode.project_id, episode, look_count: 2, image_count: 3, scored_dimensions: 6, default_look_id: 'l-' + id, references: { shots: 20, manifests: 1, manifest_entries: 2 }, base_info_excerpt: '资料摘要', performance_info_excerpt: null, primary_locked: false, ...extra });
const fake = { lisiMerged: false, zhaoMerged: false, previews: [], confirms: [], confirmPlan: [], receipts: {}, dropPreview: false, staleOnce: false, groupReads: 0, undoPreviews: [], undos: [] };
const lisi = () => ({ group_id: 'g-lisi', name: '李四', references: { shots: 51, manifests: 2, manifest_entries: 4 }, members: [member(A, 'project', ep(1, eps[0]), { references: { shots: 31 } }), member(B, 'project', ep(2, eps[1]), { references: { shots: 20 } })] });
const zhao = () => ({ group_id: 'g-zhao', name: '赵六', references: { shots: 9 }, members: [member('z-series', 'series', null, { primary_locked: true }), member('z-ep2', 'project', ep(2, eps[1]))] });
function groups() {
  const items = [...(fake.lisiMerged ? [] : [lisi()]), ...(fake.zhaoMerged ? [] : [zhao()])];
  return { series_id: S.id, alignment_status: 'aligned', summary: { group_count: items.length, referenced_shot_count: items.reduce((n, g) => n + g.references.shots, 0), manifest_count: 2 }, items, next_cursor: null, context_token: 'grp-tok-' + fake.groupReads };
}
const look = (src, id, name, action = 'keep', result = id) => ({ source_asset_id: src, source_look_id: id, result_look_id: result, result_name: name, action, image_count: 2 });
function preview(body) {
  const g = body.group_id === 'g-lisi' ? lisi() : zhao(), others = g.members.filter(m => m.asset_id !== body.primary_asset_id);
  const lisiConflict = g.group_id === 'g-lisi' ? [{ conflict_id: 'c-casual', source_look_id: 'b-casual', allowed_targets: ['a-casual'], suggested_name: '常服（第 2 集）', default_choice: { conflict_id: 'c-casual', action: 'keep_both', rename_to: '常服（第 2 集）' }, affected_shots: 6 }] : [];
  const choices = { look_choices: lisiConflict.map(c => body.choices?.look_choices?.find(x => x.conflict_id === c.conflict_id) ?? c.default_choice) };
  const merged = choices.look_choices[0]?.action === 'merge_into';
  const items = g.group_id === 'g-lisi'
    ? [look(A, 'a-casual', '常服'), look(A, 'a-night', '夜行服'), look(B, 'b-official', '官服'), merged ? look(B, 'b-casual', '常服', 'merge_into', 'a-casual') : look(B, 'b-casual', choices.look_choices[0]?.rename_to ?? '常服（第 2 集）', 'rename')]
    : [look('z-series', 'z-a', '布衣'), look('z-ep2', 'z-b', '戎装')];
  return { ready: true, preview_token: 'mp-' + fake.previews.length, group_id: g.group_id, primary_asset_id: body.primary_asset_id, members: g.members, choices,
    look_plan: { items, conflicts: lisiConflict },
    score_plan: { series_base: { source_asset_id: body.primary_asset_id, entries: [{ dimension_id: 'd1', value: 30, source: 'manual', reason: null, updated_at: 1 }] },
      episode_overrides: others.filter(m => m.episode).map(m => ({ project_id: m.episode.project_id, source_asset_id: m.asset_id, entries: [{ dimension_id: 'd1', value: -20, source: 'ai', reason: 'AI 依据', updated_at: 1 }], manual_count: 0, ai_count: 1, clear_count: 0 })),
      existing_overrides_preserved: 0, override_conflicts: [] },
    default_look_plan: g.members.filter(m => m.episode).map(m => ({ project_id: m.episode.project_id, source_asset_id: m.asset_id, old_look_id: m.asset_id === A ? 'a-casual' : 'b-official', result_look_id: m.asset_id === A ? 'a-casual' : 'b-official', mode: 'set' })),
    reference_plan: { shots: g.references.shots, manifests: 2, manifest_entries: 4, by_episode: [], writes_storyboards: false },
    text_plan: { base_source_asset_id: body.primary_asset_id, other_sources: others.map(m => ({ source_asset_id: m.asset_id, project_id: m.episode?.project_id ?? null, base_info: '第二集换了身份，混进县衙', performance_info: '说话慢' })) },
    blockers: [] };
}
async function installMocks() {
  const under = (u, tail) => new URL(u).pathname.startsWith('/api/project-series/') && new URL(u).pathname.endsWith(tail);
  const underScope = (u, tail) => new URL(u).pathname.startsWith('/api/project-assets/scopes/') && new URL(u).pathname.endsWith(tail);
  await page.route(u => under(u, '/character-merge-groups'), route => { fake.groupReads++; return route.fulfill({ json: groups() }); });
  await page.route(u => under(u, '/character-merges/preview'), async route => {
    const body = route.request().postDataJSON(); fake.previews.push(body);
    if (fake.dropPreview) { fake.dropPreview = false; return route.abort('connectionreset'); }
    return route.fulfill({ json: preview(body) });
  });
  await page.route(u => under(u, '/character-merges/confirm'), async route => {
    const body = route.request().postDataJSON(); fake.confirms.push(body); const mode = fake.confirmPlan.shift();
    if (mode === 'abort') return route.abort('connectionreset');
    if (fake.staleOnce) { fake.staleOnce = false; return route.fulfill({ status: 409, json: { error: '已变化', code: 'CHARACTER_MERGE_STALE' } }); }
    const g = fake.previews.at(-1).group_id, isLisi = g === 'g-lisi';
    if (isLisi) fake.lisiMerged = true; else fake.zhaoMerged = true;
    const receipt = { request_id: body.request_id, merge_id: 'm-' + g, status: 'merged', series_id: S.id, group_id: g, canonical_asset_id: isLisi ? A : 'z-series', alias_count: 1, merged_look_count: isLisi ? 0 : 0, references: { shots: isLisi ? 51 : 9 }, history_id: 'h1', can_undo: true, remaining_group_count: groups().items.length, next_group_id: groups().items[0]?.group_id ?? null };
    fake.receipts[body.request_id] = receipt;
    if (mode === 'drop') return route.abort('connectionreset');
    return route.fulfill({ json: receipt });
  });
  await page.route(u => /\/character-merge-requests\/[^/]+$/.test(new URL(u).pathname), route => {
    const id = new URL(route.request().url()).pathname.split('/').pop(), r = fake.receipts[id];
    return route.fulfill({ json: r ? { found: true, result: r } : { found: false } });
  });
  await page.route(u => /\/character-merges\/[^/]+\/undo-preview$/.test(new URL(u).pathname), route => { fake.undoPreviews.push(route.request().postDataJSON());
    return route.fulfill({ json: { ready: true, undo_token: 'ud-1', merge_id: 'm-g-zhao', status: 'review_required', blockers: [], changes: [{ entity: 'image', entity_id: 'i9', project_id: null, kind: '合并后新加的图片', action: 'restore_with_confirmation' }] } }); });
  await page.route(u => /\/character-merges\/[^/]+\/undo$/.test(new URL(u).pathname), route => { const body = route.request().postDataJSON(); fake.undos.push(body); fake.zhaoMerged = false;
    return route.fulfill({ json: { request_id: body.request_id, merge_id: 'm-g-zhao', status: 'undone', restored_asset_ids: ['z-series', 'z-ep2'], history_id: 'h2' } }); });
  await page.route(u => new RegExp('/assets/' + A + '/versions$').test(new URL(u).pathname), async route => {
    const res = await route.fetch(), data = await res.json();
    return route.fulfill({ json: [{ id: 'v-merge', version: 9, summary: '合并同名人物：合入第 2 集的「李四」', created_at: Date.now(), kind: 'character_merge', merge_id: 'm-g-lisi', request_id: 'r1', at: Date.now(), can_undo: true }, ...data] });
  });
  // 新建撞名：真实检查照常，按合同补 related_characters
  await page.route(u => underScope(u, '/names/check'), async route => {
    const body = route.request().postDataJSON(), res = await route.fetch(), data = await res.json();
    if (body.name !== '李四') return route.fulfill({ status: res.status(), json: data });
    return route.fulfill({ json: { ...data, status: data.status === 'inherit_shared' ? 'conflict' : data.status, related_characters: { group_id: 'g-lisi', action: 'merge', items: lisi().members } } });
  });
}

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  S = await api('/project-series', { name: '穿越计', software: 'jianying', request_id: rid() });
  const q = await api(`/project-series/${S.id}/seasons`, { request_id: rid() });
  for (let i = 1; i <= 2; i++) eps.push((await api(`/project-series/${S.id}/episodes`, { season_id: q.id, expected_episode_no: i, request_id: rid() })).project);
  A = (await api('/project-assets/assets', { project_id: eps[0].id, kind: 'character', name: '李四' })).id;
  B = (await api('/project-assets/assets', { project_id: eps[1].id, kind: 'character', name: '李四' })).id;

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => { try { localStorage.setItem('shiguang.refreshSeconds', '0'); } catch {} });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await installMocks();
  await page.goto(origin + '/#/all'); await expect(page.locator('.ppb').first()).toHaveAttribute('data-project', /./);
  await selectProjectInBar(page, eps[0].id); await nav('项目资产');

  await check('B0 集视图：李四卡片提示「第 2 集也有一个」，卡片菜单有「合并同名人物…」', async () => {
    const card = work().locator('.ca-card-wrap').filter({ hasText: '李四' }).first();
    await expect(card.locator('.cm-card-hint')).toHaveText('第 2 集也有一个「李四」');
    await card.hover(); await card.getByRole('button', { name: '李四的更多操作' }).click();
    await expect(page.getByRole('menu', { name: '李四的操作' }).getByRole('menuitem', { name: '合并同名人物…' })).toBeVisible();
    await page.keyboard.press('Escape'); await work().getByRole('heading').first().click().catch(() => {});
  });

  await check('B0 全剧视图提示条：2 个人物在不同集各建了一份、共被 60 个镜头引用；逐个合并打开第一组，主体可选', async () => {
    await scopeSwitch().getByRole('button', { name: '全剧', exact: true }).click();
    const banner = work().locator('.cm-banner'); await expect(banner).toContainText('2 个人物'); await expect(banner).toContainText('共被 60 个镜头引用');
    await banner.getByRole('button', { name: '逐个合并' }).click();
    const dlg = page.getByRole('dialog', { name: '合并「李四」' }); await expect(dlg).toContainText('第 1 步');
    await expect(dlg.getByRole('radio', { name: /第 1 集的「李四」/ })).toBeChecked(); await expect(dlg.getByRole('radio', { name: /第 2 集的「李四」/ })).toBeEnabled();
    await expect(dlg).toContainText('被 31 个镜头引用'); await shot('1-pick');
  });

  await check('B1 合并后的样子：预览只带组、主体和列表凭证；造型、评分（第 2 集保留为本集覆盖）、默认造型、分镜不改写、其他份资料可复制', async () => {
    const dlg = page.getByRole('dialog', { name: '合并「李四」' });
    await dlg.getByRole('button', { name: '看合并后的样子' }).click();
    await expect(dlg).toContainText('合并后的样子');
    const p = fake.previews.at(-1); assert.equal(p.group_id, 'g-lisi'); assert.equal(p.primary_asset_id, A); assert.match(p.context_token, /^grp-tok-/); assert.equal(p.choices, undefined);
    await expect(dlg).toContainText('造型 · 合并后 4 个'); await expect(dlg).toContainText('1 个同名造型，下一步处理');
    await expect(dlg).toContainText('原来的 1 项分数保留为「本集覆盖」'); await expect(dlg).toContainText('AI 打的，保留来源和依据');
    await expect(dlg).toContainText('设为本集默认造型'); await expect(dlg).toContainText('分镜引用 · 51 个镜头，不改动');
    await dlg.getByRole('button', { name: '复制原文' }).click(); await expect(dlg.getByRole('button', { name: '已复制' })).toBeVisible();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '第二集换了身份，混进县衙\n\n说话慢');
    await expect(dlg.getByRole('button', { name: '处理 1 个同名造型' })).toBeVisible(); await shot('2-impact');
  });

  await check('B1 同名造型：默认都保留并加集名；改选重新预览；改选预览断网 → 不能确认、给「重新核对」', async () => {
    const dlg = page.getByRole('dialog', { name: '合并「李四」' });
    await dlg.getByRole('button', { name: '处理 1 个同名造型' }).click(); await expect(dlg).toContainText('需要处理 1 项');
    await expect(dlg.getByRole('radio', { name: /都保留/ })).toBeChecked(); await expect(dlg.getByLabel('新造型名称')).toHaveValue('常服（第 2 集）');
    await dlg.getByRole('radio', { name: /合成一个/ }).check();
    await expect.poll(() => fake.previews.at(-1).choices?.look_choices?.[0]?.action).toBe('merge_into');
    fake.dropPreview = true; await dlg.getByRole('radio', { name: /都保留/ }).check();
    await expect(dlg.getByRole('alert')).toContainText('还没核对成功'); await expect(dlg.getByRole('radio', { name: /都保留/ })).toBeChecked();
    await expect(dlg.getByRole('button', { name: '确认合并' })).toBeDisabled(); await shot('3-issues-unchecked');
    await dlg.getByRole('button', { name: '重新核对' }).click(); await expect(dlg.getByRole('button', { name: '重新核对' })).toHaveCount(0);
    await expect(dlg.getByRole('button', { name: '确认合并' })).toBeEnabled();
    assert.equal(fake.previews.at(-1).choices.look_choices[0].action, 'keep_both'); assert.equal(fake.confirms.length, 0, '核对失败期间不应提交');
  });

  await check('B1 确认：首发未达 → 查无回执 → 原样重发写入但回应再丢 → 保留原请求并锁定 → 核对上次结果读回原回执；完成提示带撤销和下一个', async () => {
    const dlg = page.getByRole('dialog', { name: '合并「李四」' }); const lastToken = 'mp-' + fake.previews.length; // 替身凭证编号 = 计入后的预览次数
    fake.confirmPlan.push('abort', 'drop'); await dlg.getByRole('button', { name: '确认合并' }).click();
    await expect(dlg.getByRole('alert')).toContainText('原请求已保留'); await expect(dlg.getByRole('button', { name: '核对上次结果' })).toBeEnabled(); await shot('4-lost-locked');
    await expect(dlg.getByRole('radio', { name: /都保留/ })).toBeDisabled(); await expect(dlg.getByRole('button', { name: '上一步' })).toHaveCount(0);
    assert.equal(fake.confirms.length, 2); assert.equal(fake.confirms[1].request_id, fake.confirms[0].request_id, '重发应沿用原请求号');
    const c = fake.confirms[0]; assert.equal(c.preview_token, lastToken, '确认用最后一次成功核对的凭证'); assert.match(c.context_token, /^grp-tok-/); assert.deepEqual(c.choices.look_choices, [{ conflict_id: 'c-casual', action: 'keep_both', rename_to: '常服（第 2 集）' }]);
    await dlg.getByRole('button', { name: '核对上次结果' }).click(); await expect(dlg).toHaveCount(0);
    assert.equal(fake.confirms.length, 2, '查到原回执后不应再发确认');
    const done = work().locator('.cm-done'); await expect(done).toContainText('已合并「李四」：现在是全剧共享人物，4 个造型，51 个镜头都指向它');
    await expect(done.getByRole('button', { name: '撤销' })).toBeVisible(); await expect(done.getByRole('button', { name: '下一个（还剩 1 个）' })).toBeVisible(); await shot('5-done');
  });

  await check('B1 下一个：组里有全剧共享人物 → 主体锁定为它；确认遇到依赖过期 → 重读组和凭证、重新预览、不自动提交', async () => {
    await work().locator('.cm-done').getByRole('button', { name: /^下一个/ }).click();
    const dlg = page.getByRole('dialog', { name: '合并「赵六」' });
    await expect(dlg.getByRole('radio', { name: /全剧的「赵六」/ })).toBeChecked(); await expect(dlg.getByRole('radio', { name: /第 2 集的「赵六」/ })).toBeDisabled();
    await expect(dlg).toContainText('主体只能是它'); await shot('6-locked');
    await dlg.getByRole('button', { name: '看合并后的样子' }).click(); await expect(dlg).toContainText('沿用全剧「赵六」原来的分数');
    const reads = fake.groupReads, sent = fake.confirms.length, previews = fake.previews.length; fake.staleOnce = true;
    await dlg.getByRole('button', { name: '确认合并' }).click();
    await expect(dlg.getByRole('status').filter({ hasText: '已按最新情况重新核对' })).toBeVisible();
    assert.equal(fake.confirms.length, sent + 1, '过期后不应自动再提交'); assert.ok(fake.groupReads > reads, '应重读组'); assert.ok(fake.previews.length > previews, '应重新预览');
    assert.equal(fake.previews.at(-1).context_token, 'grp-tok-' + fake.groupReads, '重新预览用最新读到的凭证'); assert.notEqual(fake.confirms.at(-1).context_token, fake.previews.at(-1).context_token, '凭证应已更新');
    await dlg.getByRole('button', { name: '确认合并' }).click(); await expect(dlg).toHaveCount(0);
    await expect(work().locator('.cm-done')).toContainText('已合并「赵六」'); await expect(work().locator('.cm-done').getByRole('button', { name: /^下一个/ })).toHaveCount(0);
  });

  await check('B3 撤销：合并后又改过 → 列出改动，勾选确认后才能撤销；撤销带确认标记，完成后提示', async () => {
    await work().locator('.cm-done').getByRole('button', { name: '撤销' }).click();
    const dlg = page.getByRole('dialog', { name: '撤销合并「赵六」' }); await expect(dlg).toContainText('合并后新加的图片');
    await expect(dlg.getByRole('button', { name: '撤销合并' })).toBeDisabled(); await shot('7-undo-review');
    await dlg.getByRole('checkbox', { name: /我已核对/ }).check(); await dlg.getByRole('button', { name: '撤销合并' }).click(); await expect(dlg).toHaveCount(0);
    const u = fake.undos.at(-1); assert.equal(u.undo_token, 'ud-1'); assert.equal(u.accept_restore_changes, true); assert.match(u.request_id, /^[0-9a-f-]{36}$/);
    await expect(work()).toContainText('已撤销合并「赵六」');
  });

  await check('B0 新建撞名：全剧新建「李四」→ 提示第 1、2 集已各有一个；「换个名字」回到原表单、不建；「合并这几个」打开合并浮窗', async () => {
    fake.lisiMerged = false;
    const before = (await api(`/project-assets/scopes/series/${S.id}/assets?kind=character`)).total;
    await work().getByRole('button', { name: /^新建/ }).first().click(); const dlg = page.getByRole('dialog', { name: '新建资产' });
    await dlg.getByLabel('新资产名称').fill('李四'); await dlg.getByRole('button', { name: '创建并编辑' }).click();
    await expect(dlg.getByRole('alert')).toContainText('第 1 集、第 2 集已经各有一个「李四」'); await shot('8-create-ask'); await expect(dlg.getByRole('alert')).toContainText('不是同一个人：换个名字再创建');
    await dlg.getByRole('button', { name: '换个名字' }).click(); await expect(dlg.locator('.cm-create-ask')).toHaveCount(0); await expect(dlg.getByRole('button', { name: '创建并编辑' })).toBeVisible();
    await dlg.getByRole('button', { name: '创建并编辑' }).click(); await dlg.getByRole('button', { name: '合并这几个「李四」…' }).click();
    await expect(dlg).toHaveCount(0); await expect(page.getByRole('dialog', { name: '合并「李四」' })).toBeVisible();
    await page.getByRole('dialog', { name: '合并「李四」' }).getByRole('button', { name: '取消' }).click();
    assert.equal((await api(`/project-assets/scopes/series/${S.id}/assets?kind=character`)).total, before, '提示期间不应新建');
  });

  await check('B3 来源与版本：列出合并记录，可从这里打开「撤销这次合并…」', async () => {
    await scopeSwitch().getByRole('button').first().click();
    await work().locator('.ca-card').filter({ hasText: '李四' }).first().click(); await expect(work().locator('.ca-name-input')).toHaveValue('李四');
    await work().getByRole('button', { name: '资料操作' }).click(); await work().getByRole('menuitem', { name: /来源与版本/ }).click();
    const hist = page.getByRole('dialog', { name: '来源与版本' }); await expect(hist).toContainText('合并同名人物：合入第 2 集的「李四」');
    await hist.getByRole('button', { name: '撤销这次合并…' }).click(); await expect(hist).toHaveCount(0);
    const undo = page.getByRole('dialog', { name: '撤销合并「李四」' }); await expect(undo).toBeVisible(); assert.equal(fake.undoPreviews.length, 2, '应按合并编号重新核对撤销');
    await undo.getByRole('button', { name: '取消' }).click();
  });

  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-2500)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'character-merge-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); let timer; if (await Promise.race([exited, new Promise(r => timer = setTimeout(() => r('timeout'), 10000))]) === 'timeout') { child.kill('SIGKILL'); await exited; } clearTimeout(timer);
  await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
