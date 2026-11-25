// 剧本区前端 + 真后端（Codex 的 /api/project-scripts）：新建临时库、合成剧本和合成资料，不接真实素材库、不调模型。
// agent 那一侧（冻结草稿快照、上传泳道图）直接调接口；用户那一侧（定稿、上传/删除资料、看图、试画）走页面。
// 截图写到 SCRIPT_AREA_SHOTS（不设就不截）。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { selectProjectInBar } from './helpers/path-bar.mjs';
import { readFixture } from './fixtures/script-area/make-render-data.mjs';
import { syntheticDocx } from './fixtures/script-area/synthetic-docx.mjs';

const root = path.resolve(import.meta.dirname, '..'), fixtures = path.join(root, 'tests/fixtures/script-area');
const shots = process.env.SCRIPT_AREA_SHOTS || '';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'script-area-real-ui-'));
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, library, passed = false; const checks = [], errors = [], external = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal_item'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1', MEDIA_CODEX_AUTOCONNECT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) {
  const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'x-shiguang-library-id': library, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json(); assert.ok(response.ok, p + ' ' + response.status + ' ' + JSON.stringify(data)); return data;
}
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const shot = async (name, target = page) => { if (shots) await target.screenshot({ path: path.join(shots, 'real-' + name + '.png'), fullPage: true }); };
const rid = () => crypto.randomUUID();
const area = () => page.getByRole('region', { name: '剧本区' });
const tab = name => area().getByRole('tablist', { name: '剧本区' }).getByRole('tab', { name: new RegExp('^' + name) });
const historyButton = () => area().getByRole('button', { name: '历史版本' });
async function openHistory(name) { await historyButton().click(); await area().getByRole('menu', { name: '历史版本' }).getByRole('menuitem', { name }).click(); }
const sources = readFixture('fixture_sources');

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token; library = session.instanceId;
  const S = await api('/project-series', { name: '合成剧', software: 'jianying', request_id: rid() });
  const q = await api(`/project-series/${S.id}/seasons`, { request_id: rid() });
  const ep = (await api(`/project-series/${S.id}/episodes`, { season_id: q.id, expected_episode_no: 1, request_id: rid() })).project;
  const P = `/project-scripts/projects/${ep.id}`;
  const saveDraft = async (title, content) => { const now = await api(`/project-assets/projects/${ep.id}/script`); return api(`/project-assets/projects/${ep.id}/script`, { title, content, expected_revision: now.revision }, 'PUT'); };
  const freeze = async () => { const d = await api(P + '/draft'); return (await api(P + '/draft/snapshots', { expected_revision: d.revision, contentDigest: d.contentDigest, requestId: rid() })).snapshot; };
  // agent 那一侧：两份草稿快照（合成 v1、v2 正文）
  await saveDraft('合成剧本', sources['fixture-v1'].text); const snap1 = await freeze();
  await saveDraft('合成剧本', sources['fixture-v2'].text); const snap2 = await freeze();

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { const u = new URL(r.url()); if (u.origin !== origin && !u.protocol.startsWith('data') && !u.protocol.startsWith('blob')) external.push(r.url()); });
  await page.goto(origin + '/#/project-scripts'); await page.reload(); await selectProjectInBar(page, ep.id);
  await expect(area()).toBeVisible();

  await check('真接口：页头写当前稿的保存时间；还没有历史版本时不显示「历史版本」；第一次定稿是 V1，之后在历史版本里只读打开、回到当前稿', async () => {
    await expect(area().getByLabel('当前看的是')).toContainText('当前稿（');
    await expect(area().getByLabel('当前看的是')).toContainText('存过');
    await expect(historyButton()).toHaveCount(0);
    await expect(area().getByRole('navigation', { name: '版本' })).toHaveCount(0);
    await area().getByRole('button', { name: '定稿', exact: true }).click();
    const dlg = page.getByRole('dialog', { name: '定稿' });
    await expect(dlg.getByRole('heading')).toHaveText('定稿成 V1');
    await expect(dlg.getByLabel('开头几行')).toContainText('2-1 地下 · 夜');
    await dlg.getByRole('button', { name: '确认定稿' }).click();
    await expect(dlg).toHaveCount(0); await expect(area()).toContainText('已定稿成 V1');
    await expect(historyButton()).toBeVisible();
    await openHistory(/^V1/);
    await expect(area().getByLabel('当前看的是')).toContainText(/^正在看 V1（只读） · /);
    await expect(area().getByRole('button', { name: '定稿', exact: true })).toHaveCount(0);
    await expect(area().getByRole('document', { name: '剧本正文（只读）' })).toContainText('小周没拉住老李。');
    await area().getByRole('button', { name: '回到当前稿' }).click();
    await expect(area().getByLabel('当前看的是')).toContainText('当前稿（');
  });

  await check('真接口：定稿前草稿被别处改过 → 409 提示并重读，换新 requestId 后能定成 V2', async () => {
    await area().getByRole('button', { name: '定稿', exact: true }).click();
    const dlg = page.getByRole('dialog', { name: '定稿' }); await expect(dlg.getByRole('heading')).toHaveText('定稿成 V2');
    await saveDraft('合成剧本', sources['fixture-v2'].text + '别处加的一行。\n');
    await dlg.getByRole('button', { name: '确认定稿' }).click();
    await expect(dlg).toContainText('草稿在你确认前又改过了');
    await expect(dlg.getByLabel('开头几行')).toBeVisible();
    await dlg.getByRole('button', { name: '确认定稿' }).click();
    await expect(dlg).toHaveCount(0);
    await historyButton().click(); await expect(area().getByRole('menu', { name: '历史版本' }).getByRole('menuitem')).toHaveText([/^V2/, /^V1/]); await page.keyboard.press('Escape');
  });

  let material;
  await check('真接口：甲方资料上传（TXT，挂本集）、带行号预览、勾全局进全局组', async () => {
    await tab('甲方资料').click();
    const mats = area().getByRole('region', { name: '甲方资料' });
    await mats.getByLabel('选择要上传的甲方资料').setInputFiles({ name: '合成文学稿.txt', mimeType: 'text/plain', buffer: Buffer.from(sources['fixture-a'].text, 'utf8') });
    await mats.getByRole('button', { name: '上传', exact: true }).click();
    await expect(mats).toContainText('已上传「合成文学稿.txt」，挂在本集');
    await mats.locator('.sa-material', { hasText: '合成文学稿.txt' }).getByRole('button', { name: '预览' }).click();
    const dlg = page.getByRole('dialog', { name: '预览：合成文学稿.txt' });
    await expect(dlg.locator('.sa-line-no')).toHaveCount(11); await expect(dlg.locator('li').nth(1)).toHaveText('L2 ');
    await dlg.getByRole('button', { name: '关闭' }).click();
    await mats.getByLabel('选择要上传的甲方资料').setInputFiles({ name: '合成人物小传.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%合成\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n') });
    await mats.getByRole('checkbox', { name: /放到全局资料/ }).check();
    await mats.getByRole('button', { name: '上传', exact: true }).click();
    await expect(mats).toContainText('放在全局资料里');
    await expect(mats.locator('.sa-material', { hasText: '合成人物小传.pdf' }).locator('.sa-chip')).toHaveText('全局');
    await mats.getByLabel('选择要上传的甲方资料').setInputFiles({ name: '合成文学稿.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await syntheticDocx() });
    await mats.getByRole('button', { name: '上传', exact: true }).click();
    await expect(mats).toContainText('已上传「合成文学稿.docx」');
    await mats.locator('.sa-material', { hasText: '合成文学稿.docx' }).getByRole('button', { name: '预览' }).click();
    await expect(page.getByRole('document', { name: 'DOCX 预览：合成文学稿.docx' })).toContainText('合成 DOCX 第一段');
    await page.getByRole('dialog', { name: '预览：合成文学稿.docx' }).getByRole('button', { name: '关闭' }).click();
    material = (await api(P + '/materials')).items.find(m => m.originalFilename === '合成文学稿.txt');
    assert.ok(material.sourceId);
    await shot('materials');
  });

  await check('真接口：试画页用真的 dry-run 画图；反例（差一行）列出问题和实际行号；不保存', async () => {
    const single = readFixture('fixture_single'); single.sources[0].sourceId = material.sourceId;
    const singleFile = path.join(temp, 'single.json'); await fs.writeFile(singleFile, JSON.stringify(single));
    const bad = readFixture('fixture_bad_quote_off_by_one'); for (const s of bad.sources) s.sourceId = s.key === 'V1' ? snap1.sourceId : snap2.sourceId;
    const badFile = path.join(temp, 'bad.json'); await fs.writeFile(badFile, JSON.stringify(bad));
    const before = (await api(P + '/maps')).total;
    const trial = await context.newPage(); trial.on('pageerror', e => errors.push(e.message));
    await trial.goto(origin + `/#/script-map-trial?project=${ep.id}&target=snapshot:${snap2.id}`);
    const rootEl = trial.locator('[data-trial-state]');
    await trial.getByLabel('选择泳道图 JSON').setInputFiles(singleFile);
    await expect(rootEl).toHaveAttribute('data-trial-state', 'ok');
    await expect(trial.locator('.sm-sub')).toContainText('合成文学稿');
    await trial.getByRole('button', { name: '丙：暗门走出质问甲' }).click();
    await expect(trial.getByRole('dialog', { name: '原文' })).toContainText('丙从暗门后走出。\n丙：你以为她会站在你那边？');
    await shot('trial-ok', trial);
    await trial.getByLabel('前稿（改动图才要）').selectOption(`snapshot:${snap1.id}`);
    await trial.getByLabel('选择泳道图 JSON').setInputFiles(badFile);
    await expect(rootEl).toHaveAttribute('data-trial-state', 'invalid');
    await expect(trial.locator('.sm-sheet')).toHaveCount(0);
    await expect(trial.locator('.sa-issue.is-error').first()).toContainText('L9');
    await shot('trial-invalid', trial);
    assert.equal((await api(P + '/maps')).total, before, '试画不保存');
    await trial.close();
  });

  await check('真接口：全新的浏览器（没有 Cookie、没开过主程序）直接打开试画页就能试画', async () => {
    const single = readFixture('fixture_single'); single.sources[0].sourceId = material.sourceId;
    const file = path.join(temp, 'single-fresh.json'); await fs.writeFile(file, JSON.stringify(single));
    const fresh = await browser.newContext(); assert.deepEqual(await fresh.cookies(), []);
    const trial = await fresh.newPage(); trial.on('pageerror', e => errors.push(e.message));
    await trial.goto(origin + `/#/script-map-trial?project=${ep.id}&target=snapshot:${snap2.id}`);
    const rootEl = trial.locator('[data-trial-state]');
    await expect(rootEl).toHaveAttribute('data-trial-state', 'idle');
    await trial.getByLabel('选择泳道图 JSON').setInputFiles(file);
    await expect(rootEl).toHaveAttribute('data-trial-state', 'ok');
    assert.ok((await fresh.cookies()).length > 0, '页面自己拿到了会话 Cookie');
    await fresh.close();
  });

  await check('真接口：agent 传上来的图出现在草稿的泳道图标签；点开整页看图；删掉引用的资料后显示存档摘录', async () => {
    const single = readFixture('fixture_single'); single.sources[0].sourceId = material.sourceId;
    const diff = readFixture('fixture_diff'); for (const s of diff.sources) s.sourceId = s.key === 'V1' ? snap1.sourceId : snap2.sourceId;
    await api(P + '/maps', { binding: { target: { kind: 'snapshot', id: snap2.id } }, graph: single, requestId: rid() });
    await api(P + '/maps', { binding: { before: { kind: 'snapshot', id: snap1.id }, target: { kind: 'snapshot', id: snap2.id } }, graph: diff, requestId: rid() });
    await tab('泳道图').click();
    const cards = area().getByRole('button', { name: /^打开泳道图：/ });
    await expect(cards).toHaveCount(2);
    await expect(cards.filter({ hasText: '合成样例 · 单版' })).toContainText('AI 补了 1 处');
    await expect(cards.filter({ hasText: '改动' })).toContainText('改了 5 处因果或动机，1 处措辞');
    // 冻结快照之后当前稿又改过（409 那一步），两张图都写「当前稿已经改过」（真摘要比对）
    await expect(cards.filter({ hasText: '合成样例 · 单版' })).toContainText(/画在 草稿快照 \d\d-\d\d \d\d:\d\d · 当前稿已经改过/);
    await expect(cards.filter({ hasText: '改动' })).toContainText('当前稿已经改过');
    await expect(area()).not.toContainText('迁移');
    await shot('maps');
    await cards.filter({ hasText: '改动' }).click();
    await expect(area().locator('.sm-sheet svg')).toBeVisible();
    await area().getByRole('button', { name: '小周：没拉住老李' }).click();
    const pop = area().getByRole('dialog', { name: '原文' });
    await expect(pop).toContainText('小周拉住老李。'); await expect(pop).toContainText('小周没拉住老李。');
    await shot('map-diff');
    await page.keyboard.press('Escape');
    // 阅读模式（真数据）：进出、点框、不横向滚动
    await area().getByRole('button', { name: '阅读模式' }).click();
    const reader = page.getByRole('dialog', { name: '泳道图阅读模式' });
    await expect(reader.getByRole('button', { name: '退出阅读' })).toBeFocused();
    await expect(reader.locator('.sa-reading-bar')).toContainText('依据：合成剧本');
    const sc = await reader.locator('.sa-reading-body').evaluate(el => el.scrollWidth <= el.clientWidth); assert.ok(sc, '阅读模式不横向滚动');
    await reader.getByRole('button', { name: '小周：没拉住老李' }).click();
    await expect(reader.getByRole('dialog', { name: '原文' })).toContainText('小周没拉住老李。');
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await expect(reader).toHaveCount(0);
    await expect(area().getByRole('button', { name: '阅读模式' })).toBeFocused();
    await area().getByRole('button', { name: '← 返回泳道图列表' }).click();
    // 删除被引用的资料
    await tab('甲方资料').click();
    const mats = area().getByRole('region', { name: '甲方资料' });
    await mats.locator('.sa-material', { hasText: '合成文学稿.txt' }).getByRole('button', { name: '删除' }).click();
    await page.getByRole('alertdialog', { name: '删除甲方资料' }).getByRole('button', { name: '删除' }).click();
    await expect(mats).toContainText('已删除「合成文学稿.txt」');
    await tab('泳道图').click();
    await area().getByRole('button', { name: /^打开泳道图：/ }).filter({ hasText: '合成样例 · 单版' }).click();
    await area().getByRole('button', { name: '甲：倒地' }).click();
    await expect(area().getByRole('dialog', { name: '原文' })).toContainText('原件已删除，以下为存档摘录');
    await expect(area().getByRole('dialog', { name: '原文' })).toContainText('甲倒地。');
    await shot('map-deleted-source');
  });

  await check('真接口回归（PR154 独验 P2-1）：图详情请求还没回来时列表刷新了，回包照样用上，点开不会卡在「正在读取」', async () => {
    const newest = (await api(P + '/maps?limit=100')).items[0];
    let release, held = 0; const gate = new Promise(r => { release = r; });
    const detailUrl = url => url.pathname === `/api${P}/maps/${newest.id}`;
    const hold = async route => { held++; await gate; await route.continue(); };
    await page.reload(); await expect(area()).toBeVisible();
    await page.route(detailUrl, hold);
    const listRefresh = page.waitForResponse(r => new URL(r.url()).pathname === `/api${P}/maps` && r.request().method() === 'GET');
    await tab('泳道图').click();               // 挂上列表就预取详情（被拦住），同时点标签又刷新一次列表
    await listRefresh; await expect.poll(() => held).toBe(1);
    await page.waitForTimeout(300);           // 让新列表数组生效，旧的预取 effect 被清理
    release();
    await area().getByRole('button', { name: '打开泳道图：' + newest.title }).first().click();
    await expect(area().locator('.sm-sheet svg')).toBeVisible();
    await expect(area()).not.toContainText('正在读取这张图');
    assert.equal(held, 1, '详情只请求了一次');
    await page.unroute(detailUrl, hold);
    await area().getByRole('button', { name: '← 返回泳道图列表' }).click();
  });

  await check('真接口回归（PR154 独验 P2-2）：草稿上有 32 张图，前 30 张以外的卡片点开也能取到详情', async () => {
    const diff = readFixture('fixture_diff'); for (const s of diff.sources) s.sourceId = s.key === 'V1' ? snap1.sourceId : snap2.sourceId;
    for (let i = 1; i <= 30; i++) await api(P + '/maps', { binding: { before: { kind: 'snapshot', id: snap1.id }, target: { kind: 'snapshot', id: snap2.id } }, graph: { ...diff, title: '合成批量图 ' + i }, requestId: rid() });
    const details = []; page.on('request', r => { if (/\/maps\/[^/?]+$/.test(new URL(r.url()).pathname) && r.method() === 'GET') details.push(new URL(r.url()).pathname); });
    await page.reload(); await expect(area()).toBeVisible();
    await tab('泳道图').click();
    const cards = area().getByRole('button', { name: /^打开泳道图：/ });
    await expect(cards).toHaveCount(32);
    const last = cards.nth(31); await expect(last).toContainText('合成样例 · 单版'); // 最早的那张排在第 32
    const lastId = (await api(P + '/maps?limit=100')).items.find(m => m.title === '合成样例 · 单版').id;
    await expect.poll(() => details.length).toBeGreaterThanOrEqual(30);
    assert.ok(!details.some(d => d.endsWith('/' + lastId)), '第 32 张不在预取里');
    await last.click();
    await expect(area().locator('.sm-sheet svg')).toBeVisible();
    assert.equal(details.filter(d => d.endsWith('/' + lastId)).length, 1, '点开时取了一次详情');
    await area().getByRole('button', { name: '← 返回泳道图列表' }).click();
  });

  await check('真接口回归（PR154 独验 P2 补充）：切集时上一集（空草稿）的草稿信息晚到，不会挡住这一集定稿', async () => {
    const A = (await api(`/project-series/${S.id}/episodes`, { season_id: q.id, expected_episode_no: 2, request_id: rid() })).project; // 空草稿
    let release, held = 0; const gate = new Promise(r => { release = r; });
    const aDraft = url => url.pathname === `/api/project-scripts/projects/${A.id}/draft`;
    const hold = async route => { held++; await gate; await route.continue(); };
    await page.reload(); await expect(area()).toBeVisible(); // 顶栏要重新读到新建的第 2 集
    const prev = page.locator('.ppb').getByRole('button', { name: '上一集：第1集' });
    if (await prev.isEnabled().catch(() => false)) await prev.click();   // 先停在第 1 集
    await expect(area().getByLabel('当前看的是')).toContainText('存过');
    await page.route(aDraft, hold);
    await page.locator('.ppb').getByRole('button', { name: '下一集：第2集' }).click(); await expect.poll(() => held).toBeGreaterThanOrEqual(1);
    await page.locator('.ppb').getByRole('button', { name: '上一集：第1集' }).click();
    await expect(area().getByLabel('当前看的是')).toContainText('存过');
    release(); await page.waitForTimeout(500);
    await area().getByRole('button', { name: '定稿', exact: true }).click();
    await expect(area()).not.toContainText('草稿是空的，不能定稿');
    const dlg = page.getByRole('dialog', { name: '定稿' });
    await expect(dlg.getByRole('heading')).toHaveText(/^定稿成 V\d+$/);
    await dlg.getByRole('button', { name: '取消' }).click();
    await page.unroute(aDraft, hold);
  });

  // 阅读模式里小卡片的可视边界（PR155 独验 P2）：卡片和关闭按钮都在窗口里，正文能读，没有多出横向滚动，Esc 先关卡片再退出，焦点回到按钮
  const popInView = async (reader, vp) => {
    const pop = reader.getByRole('dialog', { name: '原文' }); await expect(pop).toBeVisible();
    const pb = await pop.boundingBox(), bar = await reader.locator('.sa-reading-bar').boundingBox(), x = await pop.getByRole('button', { name: '关闭' }).boundingBox();
    assert.ok(pb.x >= 0 && pb.x + pb.width <= vp.width + 0.5 && pb.y >= bar.y + bar.height - 0.5 && pb.y + pb.height <= vp.height + 0.5, '卡片在窗口里：' + JSON.stringify({ pb, vp }));
    assert.ok(x.x >= 0 && x.x + x.width <= vp.width && x.y >= bar.y + bar.height - 0.5 && x.y + x.height <= vp.height, '关闭按钮看得见：' + JSON.stringify(x));
    const sc = await reader.locator('.sa-reading-body').evaluate(el => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    assert.ok(sc.sw <= sc.cw, '没有多出横向滚动：' + JSON.stringify(sc));
    return pop;
  };
  const leaveReading = async reader => {
    await page.keyboard.press('Escape'); await expect(reader.getByRole('dialog', { name: '原文' })).toHaveCount(0); await expect(reader).toBeVisible();
    await page.keyboard.press('Escape'); await expect(reader).toHaveCount(0);
    await expect(area().getByRole('button', { name: '阅读模式' })).toBeFocused();
  };

  await check('真接口回归（PR155 独验 P2-1）：宽屏打开最右边的卡片，开着把窗口缩到 390×844，卡片跟着挪回窗口里', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload(); await expect(area()).toBeVisible(); await tab('泳道图').click();
    await area().getByRole('button', { name: /^打开泳道图：合成批量图 30$/ }).click();
    await area().getByRole('button', { name: '阅读模式' }).click();
    const reader = page.getByRole('dialog', { name: '泳道图阅读模式' });
    const right = reader.getByRole('button', { name: '老李：下去看看' }); await right.click();
    await popInView(reader, { width: 1440, height: 900 });
    await page.setViewportSize({ width: 390, height: 844 });
    const pop = await popInView(reader, { width: 390, height: 844 });
    await expect(pop).toContainText('老李把铲子插进沙里。');
    await shot('reading-resize-narrow');
    await leaveReading(reader);
    await page.setViewportSize({ width: 1440, height: 900 });
    await area().getByRole('button', { name: '← 返回泳道图列表' }).click();
  });

  await check('真接口回归（PR155 独验 P2-2）：390×844 下打开合法的 10 行长引文，卡片限在窗口里，原文在卡片里滚动着读完', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `第${i + 1}行：` + '合成长引文，用来测小卡片的限高和卡片里的滚动；'.repeat(3) + '这一行到这里结束。');
    await saveDraft('合成长引文', lines.join('\n') + '\n'); const snap = await freeze();
    const graph = { schemaVersion: 1, kind: 'single', title: '合成长引文图', sources: [{ key: 'L', sourceId: snap.sourceId, label: '合成长引文' }],
      lanes: [{ id: 'a', name: '甲', hero: true }, { id: 'b', name: '乙' }],
      nodes: [{ id: 'x', lane: 'a', row: 1, kind: 'self', label: ['一整段'], refs: [{ source: 'L', start: 1, end: 10, quote: '合成长引文，用来测小卡片' }] }, { id: 'y', lane: 'b', row: 2, kind: 'seen', label: ['旁边'], refs: [{ source: 'L', start: 2, quote: '合成长引文，用来测小卡片' }] }],
      edges: [{ from: 'x', to: 'y' }] };
    await api(P + '/maps', { binding: { target: { kind: 'snapshot', id: snap.id } }, graph, requestId: rid() });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload(); await expect(area()).toBeVisible(); await tab('泳道图').click();
    // 刚冻结、当前稿没再改过：「和当前稿相同」（真摘要比对）
    await expect(area().getByRole('button', { name: '打开泳道图：合成长引文图' })).toContainText(/画在 草稿快照 \d\d-\d\d \d\d:\d\d · 和当前稿相同/);
    await area().getByRole('button', { name: '打开泳道图：合成长引文图' }).click();
    await area().getByRole('button', { name: '阅读模式' }).click();
    const reader = page.getByRole('dialog', { name: '泳道图阅读模式' });
    await reader.getByRole('button', { name: '甲：一整段' }).click();
    const pop = await popInView(reader, { width: 390, height: 844 });
    const body = pop.locator('.sm-pop-body');
    const sb = await body.evaluate(el => ({ sh: el.scrollHeight, ch: el.clientHeight }));
    assert.ok(sb.sh > sb.ch, '原文比卡片高，在卡片里滚动：' + JSON.stringify(sb));
    await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
    const txt = pop.locator('.sm-txt').first(); await expect(txt).toContainText('第10行：'); await expect(txt).toContainText('这一行到这里结束。');
    const end = await body.evaluate(el => el.scrollTop + el.clientHeight >= el.scrollHeight - 1), lb = await txt.boundingBox(), pb = await pop.boundingBox();
    assert.ok(end && lb.y + lb.height <= pb.y + pb.height + 1, '滚到底，第 10 行（原文最后一行）在卡片里：' + JSON.stringify({ end, lb, pb }));
    await shot('reading-long-quote');
    await leaveReading(reader);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await check('真接口回归（PR156 独验 P2-1）：101 个正式版本、100 多张图时，历史版本里第二页的 V1 能只读打开，「再显示后面的」能看到并打开最早那张图', async () => {
    let versionsNow = (await api(P + '/versions?limit=1')).total;
    for (; versionsNow < 101; versionsNow++) { const d = await api(P + '/draft'); await api(P + '/versions', { expected_revision: d.revision, contentDigest: d.contentDigest, requestId: rid() }); }
    const diff = readFixture('fixture_diff'); for (const s of diff.sources) s.sourceId = s.key === 'V1' ? snap1.sourceId : snap2.sourceId;
    for (let n = (await api(P + '/maps?limit=1')).total; n < 105; n++) await api(P + '/maps', { binding: { before: { kind: 'snapshot', id: snap1.id }, target: { kind: 'snapshot', id: snap2.id } }, graph: { ...diff, title: '合成第二批 ' + n }, requestId: rid() });
    const totalMaps = (await api(P + '/maps?limit=1')).total;
    await page.reload(); await expect(area()).toBeVisible();
    await historyButton().click();
    const items = area().getByRole('menu', { name: '历史版本' }).getByRole('menuitem');
    await expect(items).toHaveCount(101);
    await expect(items.last()).toContainText(/^V1/);
    await items.last().click();
    await expect(area().getByLabel('当前看的是')).toContainText(/^正在看 V1（只读）/);
    await expect(area().getByRole('document', { name: '剧本正文（只读）' })).toContainText('小周没拉住老李。');
    await area().getByRole('button', { name: '回到当前稿' }).click();
    await tab('泳道图').click();
    await expect(tab('泳道图')).toContainText(String(totalMaps));
    const cards = area().getByRole('button', { name: /^打开泳道图：/ });
    await expect(cards).toHaveCount(100);
    await area().getByRole('button', { name: `再显示后面的 ${totalMaps - 100} 张` }).click();
    await expect(cards).toHaveCount(totalMaps);
    await cards.last().click(); // 最早那张：「合成样例 · 单版」
    await expect(area().locator('.sm-sheet .sm-title')).toHaveText('合成样例 · 单版');
    await expect(area().locator('.sm-sheet svg')).toBeVisible();
    await area().getByRole('button', { name: '← 返回泳道图列表' }).click();
  });

  await check('真接口回归（PR156 独验 P2-3）：翻页途中有新图入库，列表不重复、不漏，新图看得见；再刷新也没有残留', async () => {
    await page.reload(); await expect(area()).toBeVisible(); await tab('泳道图').click();
    const cards = area().locator('[data-map-id]'), unique = async () => { const ids = await cards.evaluateAll(els => els.map(e => e.dataset.mapId)); return { n: ids.length, distinct: new Set(ids).size }; };
    await area().getByRole('button', { name: /^再显示后面的/ }).click();
    const before = (await api(P + '/maps?limit=1')).total;
    await expect(cards).toHaveCount(before);
    const diff = readFixture('fixture_diff'); for (const s of diff.sources) s.sourceId = s.key === 'V1' ? snap1.sourceId : snap2.sourceId;
    const newTitle = '翻页途中新入库的图';
    // 下一次刷新的第一页：先从真后端拿到回包（这时还是 before 张），再真的登记一张新图，然后才把这份旧的第一页交给页面
    let done = false;
    const firstPage = url => url.pathname === `/api${P}/maps` && url.searchParams.get('offset') === '0' && url.searchParams.get('limit') === '100';
    const hold = async route => {
      if (done) return route.fallback(); done = true;
      const response = await route.fetch();
      await api(P + '/maps', { binding: { before: { kind: 'snapshot', id: snap1.id }, target: { kind: 'snapshot', id: snap2.id } }, graph: { ...diff, title: newTitle }, requestId: rid() });
      await route.fulfill({ response });
    };
    await page.route(firstPage, hold);
    await tab('泳道图').click();
    await expect.poll(() => done).toBe(true);
    await expect(cards).toHaveCount(before + 1);
    assert.deepEqual(await unique(), { n: before + 1, distinct: before + 1 }, '卡片 id 都不重复');
    await expect(area().getByRole('button', { name: '打开泳道图：' + newTitle })).toBeVisible();
    await expect(tab('泳道图')).toContainText(String(before + 1));
    await page.unroute(firstPage, hold);
    await tab('泳道图').click();
    await expect(cards).toHaveCount(before + 1);
    assert.deepEqual(await unique(), { n: before + 1, distinct: before + 1 }, '再刷新也没有残留的重复卡片');
  });

  assert.deepEqual(errors, [], '页面没有报错');
  assert.deepEqual(external, [], '没有外部请求');
  passed = true;
} finally {
  await browser?.close();
  child.kill('SIGTERM'); await exited;
  await fs.rm(temp, { recursive: true, force: true });
  console.log((passed ? 'OK ' : 'FAILED ') + checks.length + ' checks');
  if (!passed) { console.log(logs.slice(-3000)); process.exitCode = 1; }
}
