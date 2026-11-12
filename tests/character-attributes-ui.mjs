// 人物属性（详情雷达图与编辑、右键查看、多选对比、项目维度配置）的界面检查。
// 后端属性接口（feat/codex-character-attributes）合入前，用 page.route 按已确认合同模拟：
// attribute-config（GET/PUT）、attribute-config/removal-preview、assets/:id/attributes（GET/PATCH）、projects/:id/attributes?asset_ids=。
// 其余走真实本地服务和合成图片；不接入真实素材库。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-attrs-')), images = path.join(temp, '合成照片'); await fs.mkdir(images);
const ffmpeg = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
const people = ['张大山', '赵乾', '工头', '李四'];
for (const [i, name] of people.entries()) {
  const run = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=0x${['aa5533', '3355aa', '33aa55', '777777'][i]}:s=300x400`, '-frames:v', '1', path.join(images, name + '.png')]);
  assert.equal(run.status, 0, run.stderr?.toString());
}
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal_item'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); assert.ok(response.ok, p + ' ' + JSON.stringify(data)); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const work = () => page.getByRole('region', { name: '项目资产库' });
const wrap = name => work().locator('.ca-card-wrap').filter({ has: page.locator('strong', { hasText: new RegExp('^' + name + '$') }) });
const section = () => work().getByRole('region', { name: '人物属性' });
const shot = async name => { if (process.env.ATTR_SHOTS) await page.screenshot({ path: path.join(process.env.ATTR_SHOTS, name + '.png') }); };

// ---- mock backend (contract: ATTRS-开工-精确合同 + 字段确认 + 合同修订-删除预览) ----
const DEFAULTS = [['dim_good_evil', '善恶', '恶', '善', '中立'], ['dim_power', '权势', '卑微', '显赫', '中等'], ['dim_initiative', '主动性', '被动', '主动', '适中'], ['dim_mind', '心智', '冲动', '深谋', '适中'], ['dim_emotion', '情绪', '隐忍', '外放', '适中'], ['dim_protagonist', '对主角', '敌对', '亲近', '中立']];
const tiers = (n, p, m) => ['极' + n, '偏' + n, m, '偏' + p, '极' + p];
const mock = { config: null, attrs: new Map(), puts: [], patches: [], previews: [], gets: 0, failNextPatch: '', failNextPut: '', nextId: 1 };
function resetConfig(projectId) { mock.config = { project_id: projectId, revision: 0, source: 'default', updated_at: null, dimensions: DEFAULTS.map(([id, name, n, p, m]) => ({ id, name, negative_label: n, positive_label: p, neutral_label: m, tier_labels: tiers(n, p, m), criterion: '' })) }; }
const attrsOf = (id, projectId) => mock.attrs.get(id) ?? { asset_id: id, project_id: projectId, config_revision: mock.config.revision, attribute_revision: 0, scores: {} };
async function installMocks(projectId) {
  await page.route(url => /\/api\/project-assets\/projects\/[^/]+\/attribute-config$/.test(url.pathname), async route => {
    const req = route.request();
    if (req.method() === 'GET') return route.fulfill({ json: mock.config });
    const body = req.postDataJSON(); mock.puts.push(body);
    if (mock.failNextPut) { const code = mock.failNextPut; mock.failNextPut = ''; return route.fulfill({ status: 409, json: { error: '冲突', code } }); }
    if (body.expected_revision !== mock.config.revision) return route.fulfill({ status: 409, json: { error: '配置已变化', code: 'CONFIG_STALE' } });
    const removed = mock.config.dimensions.filter(d => !body.dimensions.some(x => x.id === d.id)).map(d => d.id);
    const scored = removed.filter(id => [...mock.attrs.values()].some(a => id in a.scores));
    if (scored.length && body.removal_confirmation?.token !== 'tok-' + mock.config.revision) return route.fulfill({ status: 409, json: { error: '需要确认', code: 'DIMENSION_REMOVAL_CONFIRM' } });
    for (const a of mock.attrs.values()) for (const id of removed) delete a.scores[id];
    mock.config = { ...mock.config, revision: mock.config.revision + 1, source: 'user', updated_at: Date.now(), dimensions: body.dimensions.map(d => ({ ...d, id: d.id ?? 'dim_new_' + mock.nextId++ })) };
    return route.fulfill({ json: mock.config });
  });
  await page.route(url => url.pathname.endsWith('/attribute-config/removal-preview'), async route => {
    const body = route.request().postDataJSON(); mock.previews.push(body);
    const affected = body.remove.map(id => ({ dimension_id: id, name: mock.config.dimensions.find(d => d.id === id)?.name, scored_assets: [...mock.attrs.values()].filter(a => id in a.scores).length, archived_scored_assets: 0 }));
    return route.fulfill({ json: { token: 'tok-' + mock.config.revision, config_revision: mock.config.revision, affected } });
  });
  await page.route(url => /\/api\/project-assets\/assets\/[^/]+\/attributes$/.test(url.pathname), async route => {
    const req = route.request(), id = decodeURIComponent(req.url().split('/').at(-2));
    if (req.method() === 'GET') { mock.gets++; return route.fulfill({ json: attrsOf(id, projectId) }); }
    const body = req.postDataJSON(); mock.patches.push({ id, body });
    if (mock.failNextPatch) { const code = mock.failNextPatch; mock.failNextPatch = ''; return route.fulfill({ status: 409, json: { error: '冲突', code } }); }
    const cur = attrsOf(id, projectId);
    if (body.expected_attribute_revision !== cur.attribute_revision || body.expected_config_revision !== mock.config.revision) return route.fulfill({ status: 409, json: { error: '冲突', code: 'ATTRIBUTE_STALE' } });
    const next = { ...cur, config_revision: mock.config.revision, attribute_revision: cur.attribute_revision + 1, scores: { ...cur.scores } };
    for (const c of body.changes) next.scores[c.dimension_id] = { value: c.value, source: 'manual', reason: null, updated_at: Date.now() };
    mock.attrs.set(id, next); return route.fulfill({ json: next });
  });
  await page.route(url => /\/api\/project-assets\/projects\/[^/]+\/attributes$/.test(url.pathname), async route => {
    const ids = new URL(route.request().url()).searchParams.get('asset_ids').split(',');
    return route.fulfill({ json: { config_revision: mock.config.revision, items: ids.map(id => { const a = attrsOf(id, projectId); return { asset_id: id, attribute_revision: a.attribute_revision, scores: a.scores }; }) } });
  });
}

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  const project = await api('/projects', { name: '属性短片' });
  await api('/roots', { path: images, kind: 'photo' }); await expect.poll(async () => (await api('/jobs')).jobs.every(j => j.status !== 'running'), { timeout: 20000 }).toBe(true);
  const listed = await api('/assets?kind=photo'), media = Object.fromEntries((listed.assets ?? listed.items).map(m => [m.name, m]));
  const ids = {};
  for (const name of people) {
    let a = await api('/project-assets/assets', { project_id: project.id, kind: 'character', name });
    const look = crypto.randomUUID(), img = crypto.randomUUID();
    a = await api('/project-assets/assets/' + a.id, { asset: { ...a, default_look_id: look, looks: [{ id: look, name: '日常', description: '', tags: [], default_image_id: img, archived_at: null }], images: [{ id: img, look_id: look, media_asset_id: media[name + '.png'].id, reference_type: '人物身份', purpose: '', locks: '', ignores: '', confirmed: true, archived_at: null, crop: { x: 50, y: 50, zoom: 1 }, last_known_name: name + '.png' }] }, expected_revision: a.revision }, 'PUT');
    ids[name] = a.id;
  }
  resetConfig(project.id);
  mock.attrs.set(ids['张大山'], { asset_id: ids['张大山'], project_id: project.id, config_revision: 0, attribute_revision: 3, scores: { dim_good_evil: { value: 70, source: 'ai', reason: '场一救人', updated_at: Date.now() }, dim_power: { value: -80, source: 'ai', reason: null, updated_at: Date.now() }, dim_emotion: { value: -55, source: 'manual', reason: null, updated_at: Date.now() } } });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await installMocks(project.id);
  await page.goto(origin + '/#/project-assets'); await expect(work()).toBeVisible(); await page.getByLabel('资产所属项目').selectOption(project.id);
  await expect(wrap('赵乾')).toBeVisible();

  await check('详情「属性」：没评分时雷达图各轴写「未评」；编辑两维并保存，只发改动的格子和两个版本号，来源变「手动」，轴下显示档位和分数', async () => {
    await wrap('赵乾').locator('.ca-card').click(); await work().getByRole('navigation', { name: '详情分区' }).getByRole('button', { name: '属性' }).click();
    const radar = section().getByRole('img', { name: '赵乾的属性雷达图' }); await expect(radar).toBeVisible();
    await expect(radar.locator('.ca-radar-sub.is-unrated')).toHaveCount(6); await expect(section()).toContainText('还没有分数');
    await section().getByRole('button', { name: '编辑' }).click();
    await section().getByLabel('善恶数值').fill('-35'); await section().getByLabel('权势数值').fill('95'); await section().getByLabel('主动性数值').fill('70');
    await expect(section().locator('.ca-attrs-row', { hasText: '善恶' })).toContainText('偏恶 -35');
    await section().getByRole('button', { name: '保存属性' }).click(); await expect(section()).toContainText('属性已保存');
    const p = mock.patches.at(-1); assert.equal(p.id, ids['赵乾']); assert.equal(p.body.project_id, project.id); assert.equal(p.body.expected_config_revision, 0); assert.equal(p.body.expected_attribute_revision, 0);
    assert.deepEqual(p.body.changes, [{ dimension_id: 'dim_good_evil', value: -35 }, { dimension_id: 'dim_power', value: 95 }, { dimension_id: 'dim_initiative', value: 70 }]);
    await expect(section().locator('.ca-attrs-source')).toContainText('手动');
    await expect(radar).toContainText('偏恶 -35'); await expect(radar).toContainText('极显赫 +95'); await expect(radar).toContainText('极主动 +70'); await expect(radar.locator('.ca-radar-unrated')).toHaveCount(3);
    await section().scrollIntoViewIfNeeded(); await shot('detail');
  });

  await check('档位边界按 -60 / -59 / -20 / -19 / 19 / 20 / 59 / 60 切分；清空发 null 并显示「未评」', async () => {
    await section().getByRole('button', { name: '编辑' }).click(); const row = () => section().locator('.ca-attrs-row', { hasText: '心智' }), num = section().getByLabel('心智数值');
    for (const [v, t] of [[-60, '极冲动'], [-59, '偏冲动'], [-20, '偏冲动'], [-19, '适中'], [19, '适中'], [20, '偏深谋'], [59, '偏深谋'], [60, '极深谋']]) { await num.fill(String(v)); await expect(row()).toContainText(t + ' ' + (v > 0 ? '+' : '') + v); }
    await section().getByRole('button', { name: '取消' }).click();
    await section().getByRole('button', { name: '编辑' }).click(); await section().locator('.ca-attrs-row', { hasText: '主动性' }).getByRole('button', { name: '清空' }).click();
    await expect(section().locator('.ca-attrs-row', { hasText: '主动性' })).toContainText('未评');
    await section().getByRole('button', { name: '保存属性' }).click(); await expect(section()).toContainText('属性已保存');
    assert.deepEqual(mock.patches.at(-1).body.changes, [{ dimension_id: 'dim_initiative', value: null }]);
    await expect(section().getByRole('img', { name: '赵乾的属性雷达图' })).not.toContainText('极主动');
  });

  await check('版本冲突：保存回 409 ATTRIBUTE_STALE 时提示并重新读取，正在编辑的值保留', async () => {
    await section().getByRole('button', { name: '编辑' }).click(); await section().getByLabel('情绪数值').fill('40');
    const gets = mock.gets; mock.failNextPatch = 'ATTRIBUTE_STALE';
    await section().getByRole('button', { name: '保存属性' }).click();
    await expect(page.getByText('这个人物的属性刚在别处改过，已重新读取').first()).toBeVisible(); await expect.poll(() => mock.gets).toBeGreaterThan(gets);
    await expect(section().getByLabel('情绪数值')).toHaveValue('40');
    await section().getByRole('button', { name: '保存属性' }).click(); await expect(section()).toContainText('属性已保存');
  });

  await check('右键单个人物 →「查看属性图」：小窗显示雷达图和来源，不改数据；「在详情中编辑」打开该人物详情的属性', async () => {
    const before = mock.patches.length;
    await wrap('张大山').click({ button: 'right' }); await page.getByRole('menu', { name: '张大山的操作' }).getByRole('menuitem', { name: '查看属性图' }).click();
    const pop = page.getByRole('dialog', { name: '张大山的属性图' }); await expect(pop).toBeVisible();
    const radar = pop.getByRole('img', { name: '张大山的属性雷达图' }); await expect(radar).toContainText('极善 +70'); await expect(radar).toContainText('极卑微 -80'); await expect(radar).toContainText('偏隐忍 -55');
    await expect(pop.locator('.ca-attrs-source')).toContainText('AI + 手动'); await shot('quick');
    await pop.getByRole('button', { name: '在详情中编辑 →' }).click(); await expect(pop).toHaveCount(0);
    await expect(work().locator('.ca-name-input')).toHaveValue('张大山'); await expect(section().getByRole('img', { name: '张大山的属性雷达图' })).toBeInViewport();
    assert.equal(mock.patches.length, before);
  });

  await check('多选 2 人右键 →「对比属性图（2 人）」：图例两人、按卡片顺序上色；选 4 人时这一项停用并写「最多 3 人」', async () => {
    await page.keyboard.press('Escape');
    await wrap('张大山').locator('.ca-card').click(); await wrap('赵乾').locator('.ca-card').click({ modifiers: ['Meta'] });
    await wrap('赵乾').click({ button: 'right' }); const menu = page.getByRole('menu', { name: /已选 2 个人物的操作/ });
    await menu.getByRole('menuitem', { name: /对比属性图（2 人）/ }).click();
    const pop = page.getByRole('dialog', { name: '属性对比' }); await expect(pop.locator('.ca-radar-legend')).toContainText('张大山'); await expect(pop.locator('.ca-radar-legend')).toContainText('赵乾');
    await expect(pop.locator('.ca-radar polygon[fill]')).toHaveCount(2); await shot('compare');
    await page.keyboard.press('Escape'); await expect(pop).toHaveCount(0);
    await work().getByRole('region', { name: '人物画廊' }).focus(); await page.keyboard.press('Meta+a'); await expect(work().getByRole('toolbar', { name: '已选人物操作' })).toContainText('已选 4 个人物'); await wrap('李四').click({ button: 'right' });
    const item = page.getByRole('menu', { name: /已选 4 个人物的操作/ }).getByRole('menuitem', { name: /对比属性图（4 人）/ }); await expect(item).toBeDisabled(); await expect(item).toContainText('最多 3 人');
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  });

  await check('维度设置：改名、下移、新增后保存发 PUT（带版本、新维度 id 为 null）；详情随之重读', async () => {
    await work().getByRole('button', { name: '更多资产操作' }).click(); await work().getByRole('menuitem', { name: '人物属性维度…' }).click();
    const dlg = page.getByRole('dialog', { name: '人物属性维度' }); await expect(dlg.getByLabel('第 1 个维度名称')).toHaveValue('善恶');
    await expect(dlg.getByRole('button', { name: '分享给 Agent' })).toBeVisible();
    await dlg.getByLabel('第 4 个维度名称').fill('城府'); await dlg.getByRole('button', { name: '下移城府' }).click();
    await dlg.getByRole('button', { name: '新增维度' }).click(); await dlg.getByLabel('第 7 个维度名称').fill('财力'); await dlg.getByLabel('财力左端名称').fill('贫'); await dlg.getByLabel('财力右端名称').fill('富');
    await expect(dlg.locator('.ca-attr-dim').nth(6).locator('.ca-attr-tiers')).toContainText('极贫');
    await shot('config'); await dlg.getByRole('button', { name: '保存配置' }).click(); await expect(dlg).toHaveCount(0);
    const put = mock.puts.at(-1); assert.equal(put.expected_revision, 0); assert.deepEqual(put.dimensions.map(d => d.name), ['善恶', '权势', '主动性', '情绪', '城府', '对主角', '财力']);
    assert.equal(put.dimensions[6].id, null); assert.deepEqual(put.dimensions[6].tier_labels, ['极贫', '偏贫', '中立', '偏富', '极富']); assert.equal(put.dimensions[4].id, 'dim_mind');
    await wrap('张大山').locator('.ca-card').click(); await expect(section().getByRole('img', { name: '张大山的属性雷达图' })).toContainText('财力');
  });

  await check('删除有分数的维度：先看影响（几个人物有分数）再「删除并保存」，PUT 带确认 token；配置过期时提示并重读', async () => {
    await work().getByRole('button', { name: '更多资产操作' }).click(); await work().getByRole('menuitem', { name: '人物属性维度…' }).click();
    const dlg = page.getByRole('dialog', { name: '人物属性维度' }); await expect(dlg.getByLabel('第 1 个维度名称')).toHaveValue('善恶');
    await dlg.getByRole('button', { name: '删除善恶' }).click(); await dlg.getByRole('button', { name: '保存配置' }).click();
    await expect(dlg.getByRole('alert')).toContainText('「善恶」：2 个人物有分数'); assert.deepEqual(mock.previews.at(-1).remove, ['dim_good_evil']);
    const puts = mock.puts.length; await dlg.getByRole('button', { name: '删除并保存' }).click(); await expect(dlg).toHaveCount(0);
    assert.equal(mock.puts.length, puts + 1); assert.deepEqual(mock.puts.at(-1).removal_confirmation, { token: 'tok-1' });
    await work().getByRole('button', { name: '更多资产操作' }).click(); await work().getByRole('menuitem', { name: '人物属性维度…' }).click();
    const again = page.getByRole('dialog', { name: '人物属性维度' }); await again.getByLabel('第 1 个维度名称').fill('权位');
    mock.failNextPut = 'CONFIG_STALE'; await again.getByRole('button', { name: '保存配置' }).click();
    await expect(again.getByRole('alert')).toContainText('维度刚在别处改过，已重新读取'); await expect(again.getByLabel('第 1 个维度名称')).toHaveValue('权势');
    await again.getByRole('button', { name: '取消' }).click(); await expect(again).toHaveCount(0);
  });

  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-3000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'creative-attrs-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); await exited; await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
