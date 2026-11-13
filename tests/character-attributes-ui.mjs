// 人物属性（详情雷达图与编辑、右键查看、多选对比、项目维度配置）的界面检查。
// 全部走真实本地服务（属性后端 #74）和合成图片；不接入真实素材库。另一处写入用接口模拟「别处同时修改」。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { selectProjectInBar } from './helpers/path-bar.mjs';

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

const D = Object.fromEntries(['善恶', '权势', '主动性', '心智', '情绪', '对主角'].map((n, i) => [n, '893bf172-b62a-4c92-a606-66e12df0cf0' + i]));
const sent = { patch: [], put: [], preview: [] };
const attrs = id => api('/project-assets/assets/' + id + '/attributes');
const config = pid => api('/project-assets/projects/' + pid + '/attribute-config');
const aiScore = async (pid, scores) => { const c = await config(pid); return api('/project-assets/projects/' + pid + '/attribute-scores', { request_id: crypto.randomUUID(), config_revision: c.revision, scores }); };
const openConfig = async () => { await work().getByRole('button', { name: '更多资产操作' }).click(); await work().getByRole('menuitem', { name: '人物属性维度…' }).click(); const d = page.getByRole('dialog', { name: '人物属性维度' }); await expect(d.getByLabel('第 1 个维度名称')).not.toHaveValue(''); return d; };

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
  // 张大山: two AI scores and one manual score.
  await aiScore(project.id, [{ asset_id: ids['张大山'], dimension_id: D['善恶'], value: 70, reason: '场一救人' }, { asset_id: ids['张大山'], dimension_id: D['权势'], value: -80, reason: '佃户' }]);
  { const a = await attrs(ids['张大山']); await api('/project-assets/assets/' + ids['张大山'] + '/attributes', { project_id: project.id, expected_config_revision: a.config_revision, expected_attribute_revision: a.attribute_revision, changes: [{ dimension_id: D['情绪'], value: -55 }] }, 'PATCH'); }
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { const u = new URL(r.url()); if (/\/attributes$/.test(u.pathname) && r.method() === 'PATCH') sent.patch.push(r.postDataJSON()); if (u.pathname.endsWith('/attribute-config') && r.method() === 'PUT') sent.put.push(r.postDataJSON()); if (u.pathname.endsWith('/removal-preview')) sent.preview.push(r.postDataJSON()); });
  await page.goto(origin + '/#/project-assets'); await expect(work()).toBeVisible(); await selectProjectInBar(page, project.id);
  await expect(wrap('赵乾')).toBeVisible();

  await check('详情「属性」：没评分时各轴写「未评」；编辑三维并保存，只发改动的格子和两个版本号，来源变「手动」，轴下显示档位和分数', async () => {
    await wrap('赵乾').locator('.ca-card').click(); await work().getByRole('navigation', { name: '详情分区' }).getByRole('button', { name: '属性' }).click();
    const radar = section().getByRole('img', { name: '赵乾的属性雷达图' }); await expect(radar).toBeVisible();
    await expect(radar.locator('.ca-radar-sub.is-unrated')).toHaveCount(6); await expect(section()).toContainText('还没有分数');
    await section().getByRole('button', { name: '编辑' }).click();
    await section().getByLabel('善恶数值').fill('-35'); await section().getByLabel('权势数值').fill('95'); await section().getByLabel('主动性数值').fill('70');
    await expect(section().locator('.ca-attrs-row', { hasText: '善恶' })).toContainText('偏邪恶 -35');
    await section().getByRole('button', { name: '保存属性' }).click(); await expect(section()).toContainText('属性已保存');
    const p = sent.patch.at(-1); assert.equal(p.project_id, project.id); assert.equal(p.expected_config_revision, 0); assert.equal(p.expected_attribute_revision, 0);
    assert.deepEqual(p.changes, [{ dimension_id: D['善恶'], value: -35 }, { dimension_id: D['权势'], value: 95 }, { dimension_id: D['主动性'], value: 70 }]);
    const stored = await attrs(ids['赵乾']); assert.equal(stored.scores[D['权势']].value, 95); assert.equal(stored.scores[D['权势']].source, 'manual');
    await expect(section().locator('.ca-attrs-source')).toContainText('手动');
    await expect(radar).toContainText('偏邪恶 -35'); await expect(radar).toContainText('极强势 +95'); await expect(radar).toContainText('极主动 +70'); await expect(radar.locator('.ca-radar-unrated')).toHaveCount(3);
    await section().scrollIntoViewIfNeeded(); await shot('detail');
  });

  await check('档位边界按 -60 / -59 / -20 / -19 / 19 / 20 / 59 / 60 切分；清空发 null 并显示「未评」', async () => {
    await section().getByRole('button', { name: '编辑' }).click(); const row = () => section().locator('.ca-attrs-row', { hasText: '心智' }), num = section().getByLabel('心智数值');
    for (const [v, t] of [[-60, '极冲动'], [-59, '偏冲动'], [-20, '偏冲动'], [-19, '平衡'], [19, '平衡'], [20, '偏理性'], [59, '偏理性'], [60, '极理性']]) { await num.fill(String(v)); await expect(row()).toContainText(t + ' ' + (v > 0 ? '+' : '') + v); }
    await section().getByRole('button', { name: '取消' }).click();
    await section().getByRole('button', { name: '编辑' }).click(); await section().locator('.ca-attrs-row', { hasText: '主动性' }).getByRole('button', { name: '清空' }).click();
    await section().getByRole('button', { name: '保存属性' }).click(); await expect(section()).toContainText('属性已保存');
    assert.deepEqual(sent.patch.at(-1).changes, [{ dimension_id: D['主动性'], value: null }]);
    const s = (await attrs(ids['赵乾'])).scores[D['主动性']]; assert.equal(s.value, null); assert.equal(s.source, 'manual');
    await expect(section().getByRole('img', { name: '赵乾的属性雷达图' })).not.toContainText('极主动');
  });

  await check('FE1-#75 反例：只改情绪时别处 AI 给「对主角」打了分 → 409 后重读，再保存只发情绪；对主角保持 AI 分、不被变成人工分', async () => {
    await section().getByRole('button', { name: '编辑' }).click(); await section().getByLabel('情绪数值').fill('40');
    await aiScore(project.id, [{ asset_id: ids['赵乾'], dimension_id: D['对主角'], value: 30, reason: '别处打分' }]);
    await section().getByRole('button', { name: '保存属性' }).click();
    await expect(page.getByText('这个人物的属性刚在别处改过，已重新读取').first()).toBeVisible();
    await expect(section().getByLabel('情绪数值')).toHaveValue('40'); await expect(section().getByLabel('对主角数值')).toHaveValue('30');
    await section().getByRole('button', { name: '保存属性' }).click(); await expect(section()).toContainText('属性已保存');
    assert.deepEqual(sent.patch.at(-1).changes, [{ dimension_id: D['情绪'], value: 40 }]);
    const s = (await attrs(ids['赵乾'])).scores; assert.equal(s[D['对主角']].source, 'ai'); assert.equal(s[D['对主角']].value, 30); assert.equal(s[D['情绪']].source, 'manual');
  });

  await check('右键单个人物 →「查看属性图」：小窗显示雷达图和来源，不改数据；「在详情中编辑」打开该人物详情的属性', async () => {
    const before = sent.patch.length;
    await wrap('张大山').click({ button: 'right' }); await page.getByRole('menu', { name: '张大山的操作' }).getByRole('menuitem', { name: '查看属性图' }).click();
    const pop = page.getByRole('dialog', { name: '张大山的属性图' }); await expect(pop).toBeVisible();
    const radar = pop.getByRole('img', { name: '张大山的属性雷达图' }); await expect(radar).toContainText('极善良 +70'); await expect(radar).toContainText('极弱势 -80'); await expect(radar).toContainText('偏压抑 -55');
    await expect(pop.locator('.ca-attrs-source')).toContainText('AI + 手动'); await shot('quick');
    await pop.getByRole('button', { name: '在详情中编辑 →' }).click(); await expect(pop).toHaveCount(0);
    await expect(work().locator('.ca-name-input')).toHaveValue('张大山'); await expect(section().getByRole('img', { name: '张大山的属性雷达图' })).toBeInViewport();
    assert.equal(sent.patch.length, before);
  });

  await check('多选 2 人右键 →「对比属性图（2 人）」：图例两人、按卡片顺序上色；选 4 人时这一项停用并写「最多 3 人」', async () => {
    await page.keyboard.press('Escape');
    await wrap('张大山').locator('.ca-card').click(); await wrap('赵乾').locator('.ca-card').click({ modifiers: ['Meta'] });
    await wrap('赵乾').click({ button: 'right' }); await page.getByRole('menu', { name: /已选 2 个人物的操作/ }).getByRole('menuitem', { name: /对比属性图（2 人）/ }).click();
    const pop = page.getByRole('dialog', { name: '属性对比' }); await expect(pop.locator('.ca-radar-legend')).toContainText('张大山'); await expect(pop.locator('.ca-radar-legend')).toContainText('赵乾');
    await expect(pop.locator('.ca-radar polygon[fill]')).toHaveCount(2); await shot('compare');
    await page.keyboard.press('Escape'); await expect(pop).toHaveCount(0);
    await work().getByRole('region', { name: '人物画廊' }).focus(); await page.keyboard.press('Meta+a'); await expect(work().getByRole('toolbar', { name: '已选人物操作' })).toContainText('已选 4 个人物');
    await wrap('李四').click({ button: 'right' });
    const item = page.getByRole('menu', { name: /已选 4 个人物的操作/ }).getByRole('menuitem', { name: /对比属性图（4 人）/ }); await expect(item).toBeDisabled(); await expect(item).toContainText('最多 3 人');
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  });

  await check('维度设置：改没分数的维度名、下移、新增后直接保存（不需确认）；对调两端被拦下；详情随之重读', async () => {
    const dlg = await openConfig(); await expect(dlg.getByRole('button', { name: '分享给 Agent' })).toBeVisible();
    await dlg.getByLabel('情绪左端名称').fill('外露'); await dlg.getByLabel('情绪右端名称').fill('压抑');
    await expect(dlg.locator('.ca-attr-problem')).toContainText('对调了两端'); await expect(dlg.getByRole('button', { name: '保存配置' })).toBeDisabled();
    await dlg.getByLabel('情绪左端名称').fill('压抑'); await dlg.getByLabel('情绪右端名称').fill('外露');
    await dlg.getByLabel('第 4 个维度名称').fill('城府'); await dlg.getByRole('button', { name: '下移城府' }).click();
    await dlg.getByRole('button', { name: '新增维度' }).click(); await dlg.getByLabel('第 7 个维度名称').fill('财力'); await dlg.getByLabel('财力左端名称').fill('贫'); await dlg.getByLabel('财力右端名称').fill('富');
    await shot('config'); await dlg.getByRole('button', { name: '保存配置' }).click(); await expect(dlg).toHaveCount(0);
    const put = sent.put.at(-1); assert.equal(put.expected_revision, 0); assert.deepEqual(put.dimensions.map(d => d.name), ['善恶', '权势', '主动性', '情绪', '城府', '对主角', '财力']);
    assert.equal(put.dimensions[6].id, null); assert.deepEqual(put.dimensions[6].tier_labels, ['极贫', '偏贫', '中立', '偏富', '极富']); assert.equal(put.dimensions[4].id, D['心智']); assert.equal(put.preserve_scored_axes, undefined);
    assert.equal((await config(project.id)).revision, 1);
    await wrap('张大山').locator('.ca-card').click(); await expect(section().getByRole('img', { name: '张大山的属性雷达图' })).toContainText('财力');
  });

  await check('改有分数维度的文字：逐个问「只改文字」还是「含义变了」；只改文字保留分数（preserve_scored_axes），含义变了换新维度并删旧分', async () => {
    const dlg = await openConfig();
    await dlg.getByLabel('第 2 个维度名称').fill('权位');
    await dlg.getByLabel('对主角左端名称').fill('疏远'); await dlg.getByLabel('对主角右端名称').fill('亲密');
    await dlg.getByRole('button', { name: '保存配置' }).click();
    const review = dlg.getByRole('group', { name: '保存前确认' }); await expect(review).toContainText('「权势」→「权位」'); await expect(review).toContainText('「对主角」→「对主角」');
    await expect(dlg.getByRole('button', { name: '下一步' })).toBeDisabled();
    await review.getByRole('radio', { name: /只改了文字/ }).first().check(); await review.getByRole('radio', { name: /含义变了/ }).nth(1).check();
    await dlg.getByRole('button', { name: '下一步' }).click();
    const fin = dlg.getByRole('group', { name: '保存前确认' }); await expect(fin).toContainText('保存会删掉这些维度的分数'); await expect(fin).toContainText('「对主角」：1 个人物有分数'); await expect(fin).toContainText('保留分数：「权位」');
    await dlg.getByRole('button', { name: '确认删除并保存' }).click(); await expect(dlg).toHaveCount(0);
    const put = sent.put.at(-1); assert.deepEqual(put.preserve_scored_axes, [D['权势']]); assert.equal(put.dimensions.find(d => d.name === '对主角').id, null); assert.match(put.removal_confirmation.token, /^[a-f0-9]{64}$/);
    const z = (await attrs(ids['赵乾'])).scores, c = await config(project.id);
    assert.equal(z[D['权势']].value, 95, 'text-only rename keeps the score'); assert.equal(z[D['对主角']], undefined, 'meaning change drops the old score');
    assert.ok(c.dimensions.some(d => d.name === '对主角' && d.id !== D['对主角'] && d.negative_label === '疏远'));
  });

  await check('FE2-R2 反例：删除确认开着时别处给第三人补分 → 确认后后端拒绝（不删任何分），重新显示 3 人，再确认才删', async () => {
    const dlg = await openConfig();
    await dlg.getByRole('button', { name: '删除权位' }).click(); await dlg.getByRole('button', { name: '保存配置' }).click();
    const fin = dlg.getByRole('group', { name: '保存前确认' }); await expect(fin).toContainText('「权位」：2 个人物有分数');
    const rev = (await config(project.id)).revision;
    await aiScore(project.id, [{ asset_id: ids['工头'], dimension_id: D['权势'], value: 33, reason: '别处补分' }]);
    await dlg.getByRole('button', { name: '确认删除并保存' }).click();
    await expect(dlg.getByRole('alert')).toContainText('删除影响刚变了'); await expect(fin).toContainText('「权位」：3 个人物有分数');
    assert.equal((await config(project.id)).revision, rev, 'stale confirmation wrote nothing');
    assert.equal((await attrs(ids['工头'])).scores[D['权势']].value, 33); assert.equal((await attrs(ids['赵乾'])).scores[D['权势']].value, 95);
    await dlg.getByRole('button', { name: '确认删除并保存' }).click(); await expect(dlg).toHaveCount(0);
    for (const n of ['工头', '赵乾', '张大山']) assert.equal((await attrs(ids[n])).scores[D['权势']], undefined, n + ' score removed after the new confirmation');
  });

  await check('FE2-R1 反例：配置在别处被改时按字段合并——别处的判断标准和新增维度保留、我改的右端保留；同一字段两边都改时让我选', async () => {
    const dlg = await openConfig(); await dlg.getByLabel('财力右端名称').fill('豪富'); await dlg.getByLabel('财力左端名称').fill('赤贫');
    const c = await config(project.id);
    await api('/project-assets/projects/' + project.id + '/attribute-config', { expected_revision: c.revision, dimensions: [...c.dimensions.map(d => d.name === '城府' ? { ...d, criterion: '别处补了判断标准' } : d.name === '财力' ? { ...d, negative_label: '清贫', tier_labels: undefined } : d), { id: null, name: '地位', negative_label: '低', positive_label: '高', neutral_label: '中', criterion: '' }] }, 'PUT');
    await dlg.getByRole('button', { name: '保存配置' }).click();
    await expect(dlg.getByRole('alert')).toContainText('你的改动还在'); await expect(dlg.getByLabel('财力右端名称')).toHaveValue('豪富'); await expect(dlg.getByRole('button', { name: '保存配置' })).toBeDisabled();
    await dlg.getByRole('button', { name: '保留我的改动，与新版本合并' }).click();
    const conflict = dlg.getByRole('group', { name: '合并冲突' }); await expect(conflict).toContainText('「财力」的左端'); await expect(conflict).toContainText('用我的：赤贫'); await expect(conflict).toContainText('用别处的：清贫');
    await conflict.getByRole('radio', { name: /用别处的/ }).check(); await conflict.getByRole('button', { name: '按以上选择合并' }).click();
    await expect(dlg.getByRole('status')).toContainText('别处新增了「地位」'); await expect(dlg.getByLabel('第 7 个维度名称')).toHaveValue('地位');
    await dlg.getByRole('button', { name: '保存配置' }).click(); await expect(dlg).toHaveCount(0);
    const now = await config(project.id), fin = now.dimensions.find(d => d.name === '财力');
    assert.equal(fin.positive_label, '豪富', 'my edit kept'); assert.equal(fin.negative_label, '清贫', 'conflict resolved to theirs');
    assert.equal(now.dimensions.find(d => d.name === '城府').criterion, '别处补了判断标准', 'their criterion kept'); assert.ok(now.dimensions.some(d => d.name === '地位'), 'their new dimension kept');
  });

  await check('FE2-R1 边界：别处删了我没碰的维度 → 合并后跟着删；别处删了我改过的维度 → 让我选（选「不要了」就不带回）', async () => {
    const dlg = await openConfig();
    const idx = await dlg.locator('.ca-attr-dim input[aria-label$="个维度名称"]').evaluateAll(els => els.findIndex(e => e.value === '地位'));
    await dlg.locator('.ca-attr-tiers').nth(idx).click(); await dlg.getByLabel('地位判断标准').fill('看官职');
    const c = await config(project.id);
    await api('/project-assets/projects/' + project.id + '/attribute-config', { expected_revision: c.revision, dimensions: c.dimensions.filter(d => d.name !== '地位' && d.name !== '城府') }, 'PUT');
    await dlg.getByRole('button', { name: '保存配置' }).click(); await dlg.getByRole('button', { name: '保留我的改动，与新版本合并' }).click();
    const conflict = dlg.getByRole('group', { name: '合并冲突' }); await expect(conflict).toContainText('「地位」已在别处删除，但你改过它');
    await conflict.getByRole('radio', { name: '不要了' }).check(); await conflict.getByRole('button', { name: '按以上选择合并' }).click();
    await expect(dlg.getByRole('status')).toContainText('「城府」已在别处删除');
    const shown = await dlg.locator('.ca-attr-dim input[aria-label$="个维度名称"]').evaluateAll(els => els.map(e => e.value)); assert.ok(!shown.includes('地位') && !shown.includes('城府'), shown.join(','));
    await dlg.getByRole('button', { name: '保存配置' }).click(); await expect(dlg).toHaveCount(0);
    const names = (await config(project.id)).dimensions.map(d => d.name); assert.ok(!names.includes('地位') && !names.includes('城府'), names.join(','));
    assert.ok(names.includes('财力'), 'others kept');
  });

  await check('FE3-R1 反例：出现配置冲突、合并选择面板打开时，维度列表锁定不能改；合并后再改再保存', async () => {
    const dlg = await openConfig(); await dlg.getByLabel('财力右端名称').fill('殷实');
    const c = await config(project.id);
    await api('/project-assets/projects/' + project.id + '/attribute-config', { expected_revision: c.revision, dimensions: c.dimensions.map(d => d.name === '财力' ? { ...d, positive_label: '富足', tier_labels: undefined } : d) }, 'PUT');
    await dlg.getByRole('button', { name: '保存配置' }).click();
    await expect(dlg.getByLabel('情绪左端名称')).toBeDisabled();
    await dlg.getByRole('button', { name: '保留我的改动，与新版本合并' }).click();
    const conflict = dlg.getByRole('group', { name: '合并冲突' }); await expect(conflict).toContainText('「财力」的右端');
    await expect(dlg.getByLabel('情绪左端名称')).toBeDisabled(); await expect(dlg.getByText('请先处理上面的配置冲突')).toBeVisible();
    await conflict.getByRole('radio', { name: /用别处的/ }).check(); await conflict.getByRole('button', { name: '按以上选择合并' }).click();
    await expect(dlg.getByLabel('情绪左端名称')).toBeEnabled(); await dlg.getByLabel('财力判断标准').count();
    await dlg.getByRole('button', { name: '保存配置' }).click(); await expect(dlg).toHaveCount(0);
    assert.equal((await config(project.id)).dimensions.find(d => d.name === '财力').positive_label, '富足');
  });

  await check('FE3-R2 反例：最终影响预览迟到时，草稿锁定不能改；返回后显示的确认与屏幕内容一致，保存写入的就是确认过的内容', async () => {
    const dlg = await openConfig();
    await dlg.getByLabel('第 1 个维度名称').fill('善行'); await dlg.getByRole('button', { name: '删除主动性' }).click();
    let calls = 0, release; const hold = new Promise(r => { release = r; });
    const handler = async route => { calls++; if (calls === 2) await hold; return route.fallback(); };
    await page.route(url => url.pathname.endsWith('/attribute-config/removal-preview'), handler);
    await dlg.getByRole('button', { name: '保存配置' }).click();
    const review = dlg.getByRole('group', { name: '保存前确认' }); await expect(review).toContainText('「善恶」→「善行」');
    await review.getByRole('radio', { name: /只改了文字/ }).check(); await dlg.getByRole('button', { name: '下一步' }).click();
    await expect.poll(() => calls).toBe(2);
    await expect(dlg.getByLabel('第 1 个维度名称')).toBeDisabled(); await expect(dlg.getByText('正在保存，暂时不能修改')).toBeVisible(); await expect(dlg.getByRole('button', { name: '返回修改' })).toBeDisabled();
    release(); await expect(review).toContainText('保存会删掉这些维度的分数'); await expect(review).toContainText('保留分数：「善行」');
    await expect(dlg.getByLabel('第 1 个维度名称')).toBeDisabled();
    await dlg.getByRole('button', { name: '返回修改' }).click(); await expect(dlg.getByLabel('第 1 个维度名称')).toBeEnabled(); await expect(review).toHaveCount(0);
    await dlg.getByRole('button', { name: '保存配置' }).click(); await review.getByRole('radio', { name: /只改了文字/ }).check(); await dlg.getByRole('button', { name: '下一步' }).click();
    await dlg.getByRole('button', { name: '确认删除并保存' }).click(); await expect(dlg).toHaveCount(0);
    await page.unroute(url => url.pathname.endsWith('/attribute-config/removal-preview'), handler);
    const now = await config(project.id), good = now.dimensions.find(d => d.id === D['善恶']);
    assert.equal(good.name, '善行'); assert.equal(good.criterion, ''); assert.ok(!now.dimensions.some(d => d.id === D['主动性']));
    assert.equal((await attrs(ids['张大山'])).scores[D['善恶']].value, 70, 'text-only rename keeps the score');
  });

  await check('FE4-R3 反例：维度设置开着时切换项目（新项目配置迟到）→ 弹窗关闭，两个项目都不写入；新项目打开后正常保存只改自己', async () => {
    const other = await api('/projects', { name: '属性短片乙' });
    await page.reload(); await expect(work()).toBeVisible(); await selectProjectInBar(page, project.id); await expect(wrap('赵乾')).toBeVisible();
    const before = { a: (await config(project.id)).revision, b: (await config(other.id)).revision };
    const dlg = await openConfig(); await dlg.getByLabel('第 4 个维度名称').fill('仅甲项目的草稿');
    let release; const hold = new Promise(r => { release = r; }); let held = 0;
    const handler = async route => { if (route.request().method() === 'GET' && new URL(route.request().url()).pathname.includes(other.id)) { held++; if (held === 1) await hold; } return route.fallback(); };
    await page.route(url => url.pathname.endsWith('/attribute-config'), handler);
    await selectProjectInBar(page, other.id, { programmatic: true }); // 属性对话框开着（遮罩挡住顶栏），沿用旧测试绕过鼠标的切换
    await expect(dlg).toHaveCount(0);
    release(); await page.waitForTimeout(400);
    assert.equal((await config(project.id)).revision, before.a, 'project A untouched'); assert.equal((await config(other.id)).revision, before.b, 'project B untouched');
    assert.ok(!(await config(other.id)).dimensions.some(d => d.name === '仅甲项目的草稿'));
    await page.unroute(url => url.pathname.endsWith('/attribute-config'), handler);
    const dlgB = await openConfig(); await expect(dlgB).toContainText('属性短片乙'); await expect(dlgB.getByLabel('第 1 个维度名称')).toHaveValue('善恶');
    await dlgB.getByLabel('第 4 个维度名称').fill('乙项目心智'); await dlgB.getByRole('button', { name: '保存配置' }).click(); await expect(dlgB).toHaveCount(0);
    assert.equal((await config(other.id)).dimensions[3].name, '乙项目心智'); assert.equal((await config(project.id)).revision, before.a, 'project A still untouched');
  });

  await check('FE5-R4 反例：甲已提交的保存回执迟到，不会关掉乙新开的弹窗、不丢乙的草稿；甲的写入照常算甲；A→B→A 重开正常', async () => {
    const third = await api('/projects', { name: '属性短片丙' });
    await page.reload(); await expect(work()).toBeVisible(); await selectProjectInBar(page, project.id); await expect(wrap('赵乾')).toBeVisible();
    const revA = (await config(project.id)).revision, revB = (await config(third.id)).revision;
    let release, accepted = false; const gate = new Promise(r => { release = r; });
    const handler = async route => { if (route.request().method() === 'PUT' && new URL(route.request().url()).pathname.includes(project.id)) { const res = await route.fetch(); accepted = true; await gate; return route.fulfill({ response: res }); } return route.fallback(); };
    await page.route(url => url.pathname.endsWith('/attribute-config'), handler);
    const dlgA = await openConfig(); await dlgA.getByLabel('财力右端名称').fill('甲的新右端'); await dlgA.getByRole('button', { name: '保存配置' }).click();
    await expect.poll(() => accepted).toBe(true); assert.equal((await config(project.id)).revision, revA + 1, 'server accepted A');
    await expect(dlgA.getByText('正在保存，暂时不能修改')).toBeVisible();
    await selectProjectInBar(page, third.id, { programmatic: true }); await expect(dlgA).toHaveCount(0);
    const dlgB = await openConfig(); await expect(dlgB).toContainText('属性短片丙'); await dlgB.getByLabel('第 2 个维度名称').fill('乙尚未保存的新草稿');
    release(); await page.waitForTimeout(600);
    await expect(dlgB).toBeVisible(); await expect(dlgB.getByLabel('第 2 个维度名称')).toHaveValue('乙尚未保存的新草稿');
    await page.unroute(url => url.pathname.endsWith('/attribute-config'), handler);
    await dlgB.getByRole('button', { name: '保存配置' }).click(); await expect(dlgB).toHaveCount(0);
    const b = await config(third.id), aConf = await config(project.id);
    assert.equal(b.revision, revB + 1); assert.equal(b.dimensions[1].name, '乙尚未保存的新草稿');
    assert.equal(aConf.revision, revA + 1); assert.equal(aConf.dimensions.find(d => d.name === '财力').positive_label, '甲的新右端'); assert.ok(!aConf.dimensions.some(d => d.name === '乙尚未保存的新草稿'));
    await selectProjectInBar(page, project.id); await expect(wrap('赵乾')).toBeVisible();
    const again = await openConfig(); await expect(again).toContainText('属性短片'); await expect(again.getByLabel('财力右端名称')).toHaveValue('甲的新右端');
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
