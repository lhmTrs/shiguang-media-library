// 剧本区前端：侧栏入口、单集页（头部、版本条、定稿、三个标签）、试画页、请求工具三处补丁。
// 真本地服务（新建临时库）+ 剧本区接口用合同形状的假后端（page.route，见 fixtures/script-area/fake-backend.mjs）。
// 不接入真实素材库，不调用模型。截图写到 SCRIPT_AREA_SHOTS（不设就不截）。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { selectProjectInBar } from './helpers/path-bar.mjs';
import { createFakeBackend } from './fixtures/script-area/fake-backend.mjs';
import { syntheticDocx } from './fixtures/script-area/synthetic-docx.mjs';

const root = path.resolve(import.meta.dirname, '..'), fixtures = path.join(root, 'tests/fixtures/script-area');
const shots = process.env.SCRIPT_AREA_SHOTS || '';
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'script-area-ui-'));
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [], external = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal_item'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1', MEDIA_CODEX_AUTOCONNECT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); assert.ok(response.ok, p + ' ' + JSON.stringify(data)); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const shot = async (name, target = page) => { if (shots) await target.screenshot({ path: path.join(shots, name + '.png'), fullPage: target === page }); };
const rid = () => crypto.randomUUID();

const area = () => page.getByRole('region', { name: '剧本区' });
async function readingModeWorks(nodeName, shotName) {
  await area().getByRole('button', { name: /^打开泳道图：/ }).first().click();
  const enter = area().getByRole('button', { name: '阅读模式' });
  await enter.click();
  const reader = page.getByRole('dialog', { name: '泳道图阅读模式' });
  await expect(reader).toBeVisible();
  const exitBtn = reader.getByRole('button', { name: '退出阅读' });
  await expect(exitBtn).toBeFocused();
  // 盖满浏览器窗口（侧栏、顶栏都在下面）
  const vp = page.viewportSize(), box = await reader.boundingBox();
  assert.ok(box.x === 0 && box.y === 0 && Math.abs(box.width - vp.width) < 1 && Math.abs(box.height - vp.height) < 1, JSON.stringify(box));
  const bar = reader.locator('.sa-reading-bar');
  await expect(bar).toContainText('合成样例 · 单版'); await expect(bar).toContainText('依据：合成剧本（单版用）'); await expect(bar).toContainText('Esc 退出');
  await expect(reader.locator('.sm-title')).toHaveCount(0);
  await expect(reader.locator('.sm-sheet')).not.toContainText('依据：');
  // 图按窗口宽度缩放：不横向滚动，图比原始宽度宽
  const scroll = await reader.locator('.sa-reading-body').evaluate(el => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  assert.ok(scroll.sw <= scroll.cw, '阅读模式没有横向滚动：' + JSON.stringify(scroll));
  const svg = reader.locator('.sm-board svg'), natural = Number(await svg.getAttribute('viewBox').then(v => v.split(' ')[2])), shown = (await svg.boundingBox()).width;
  assert.ok(shown > natural, `图放大铺开：${shown} > ${natural}`);
  // 点框：卡片在窗口里、整个看得见
  await reader.getByRole('button', { name: nodeName }).click();
  const pop = reader.getByRole('dialog', { name: '原文' }); await expect(pop).toBeVisible();
  const pb = await pop.boundingBox(), barBox = await bar.boundingBox();
  assert.ok(pb.x >= 0 && pb.x + pb.width <= vp.width && pb.y >= barBox.y + barBox.height - 1 && pb.y + pb.height <= vp.height, '卡片在窗口里：' + JSON.stringify(pb));
  // 底部附近的框：卡片也不跑出窗口
  const lowest = reader.locator('g.sm-nd').last(); await lowest.scrollIntoViewIfNeeded(); await lowest.click();
  await expect(pop).toBeVisible(); const pb2 = await pop.boundingBox();
  assert.ok(pb2.y + pb2.height <= vp.height + 1 && pb2.y >= barBox.y + barBox.height - 1, '靠下的框，卡片也在窗口里：' + JSON.stringify(pb2));
  if (shotName) await shot(shotName);
  await page.keyboard.press('Escape'); await expect(pop).toHaveCount(0); await expect(reader).toBeVisible();
  await page.keyboard.press('Escape'); await expect(reader).toHaveCount(0);
  await expect(enter).toBeFocused();
  await area().getByRole('button', { name: '← 返回泳道图列表' }).click();
}
const tab = name => area().getByRole('tablist', { name: '剧本区' }).getByRole('tab', { name: new RegExp('^' + name) });
const historyButton = () => area().getByRole('button', { name: '历史版本' });
/** 「历史版本 ▾」下拉里的条目名（只取粗体那一行），读完把下拉关上。 */
async function historyItems() { await historyButton().click(); const items = await area().getByRole('menu', { name: '历史版本' }).getByRole('menuitem').locator('b').allInnerTexts(); await page.keyboard.press('Escape'); return items; }
async function openHistory(name) { await historyButton().click(); await area().getByRole('menu', { name: '历史版本' }).getByRole('menuitem', { name: name }).click(); }
const backToCurrent = () => area().getByRole('button', { name: '回到当前稿' }).click();
const LEGACY = /^原稿存档（\d\d-\d\d）/;

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  const S = await api('/project-series', { name: '合成剧', software: 'jianying', request_id: rid() });
  const q = await api(`/project-series/${S.id}/seasons`, { request_id: rid() });
  const ep = (await api(`/project-series/${S.id}/episodes`, { season_id: q.id, expected_episode_no: 1, request_id: rid() })).project;
  await api('/project-assets/assets', { project_id: ep.id, kind: 'character', name: '甲' });
  await api('/project-assets/assets', { project_id: ep.id, kind: 'character', name: '丙' });
  const solo = await api('/projects', { name: '单独短片' });
  const fake = createFakeBackend({ origin, cookie, libraryId: session.instanceId, projectId: ep.id });
  fake.state.seriesId = S.id;

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  await context.route('**/api/project-scripts/**', route => fake.handle(route));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { const u = new URL(r.url()); if (u.origin !== origin && !u.protocol.startsWith('data') && !u.protocol.startsWith('blob')) external.push(r.url()); });

  await check('侧栏「项目」组里「项目资产」后面是「剧本」；点开是当前这一集的剧本区', async () => {
    await page.goto(origin + '/#/project-assets'); await page.reload();
    const navItems = await page.locator('.sidebar').getByRole('button').allInnerTexts();
    const iA = navItems.findIndex(t => t.trim().startsWith('项目资产')), iS = navItems.findIndex(t => t.trim() === '剧本');
    assert.ok(iA >= 0 && iS === iA + 1, '「剧本」紧跟「项目资产」：' + JSON.stringify(navItems));
    await selectProjectInBar(page, ep.id);
    await page.locator('.sidebar').getByRole('button', { name: '剧本', exact: true }).click();
    await expect(page).toHaveURL(/#\/project-scripts$/);
    await expect(area()).toBeVisible();
    await expect(area().getByRole('heading', { level: 1 })).toContainText('合成剧');
    await expect(area().getByLabel('当前看的是')).toContainText('当前稿');
  });

  await check('历史版本：页头下面不再有一排版本按钮；标题旁「历史版本」下拉里是原稿存档（带日期，不出现「迁移」）；点开只读，页头写「正在看 …（只读）」', async () => {
    await expect(area().getByRole('navigation', { name: '版本' })).toHaveCount(0);
    assert.deepEqual((await historyItems()).map(t => LEGACY.test(t)), [true]);
    await historyButton().click();
    await expect(area().getByRole('menu', { name: '历史版本' })).toContainText('剧本区上线前保存的稿子');
    await shot('01a-history-menu');
    await page.keyboard.press('Escape');
    await openHistory(LEGACY);
    await expect(area().getByLabel('当前看的是')).toHaveText(/^正在看 原稿存档（\d\d-\d\d）（只读）回到当前稿$/);
    await expect(area().getByRole('button', { name: '定稿', exact: true })).toHaveCount(0);
    await expect(area().getByRole('document', { name: '剧本正文（只读）' })).toContainText('原稿的合成正文。');
    await expect(area().getByLabel('剧本正文', { exact: true })).toBeHidden();
    // 右栏照旧：本集出现的人物
    await expect(area().getByRole('complementary', { name: '剧本中出现的资产' }).last()).toContainText('甲');
    await expect(area()).not.toContainText('迁移');
    await shot('01-legacy-readonly');
    await backToCurrent();
    await expect(area().getByLabel('当前看的是')).toContainText('当前稿');
    await expect(area().getByRole('button', { name: '定稿', exact: true })).toBeVisible();
    await expect(area().getByLabel('剧本正文', { exact: true })).toBeVisible();
  });

  await check('定稿：空草稿说明不能定稿；有未保存修改先提示保存', async () => {
    await area().getByRole('button', { name: '定稿', exact: true }).click();
    await expect(area()).toContainText('草稿是空的，不能定稿');
    await area().getByLabel('剧本标题').fill('合成剧 第1集');
    await area().getByLabel('剧本正文', { exact: true }).fill('## 场一\n甲端起酒杯。\n乙看向门口。\n\n## 场二\n丙从暗门后走出。');
    await area().getByRole('button', { name: '定稿', exact: true }).click();
    await expect(area()).toContainText('先点「保存剧本」，再定稿');
    await expect(page.getByRole('dialog', { name: '定稿' })).toHaveCount(0);
    await area().getByRole('button', { name: '保存剧本' }).click();
    await expect(area().getByRole('button', { name: '保存剧本' })).toBeDisabled();
    await expect(area().getByLabel('当前看的是')).toContainText('存过');
    // 草稿页不再写「V」：V 只留给定稿的正式版本
    await expect(area().locator('.ca-project-script header [role=status]')).toContainText('草稿已保存');
  });

  await check('定稿对话框写清 V1、字数、最后保存时间和开头几行；确认后历史版本里出现 V1，草稿照旧', async () => {
    await area().getByRole('button', { name: '定稿', exact: true }).click();
    const dlg = page.getByRole('dialog', { name: '定稿' });
    await expect(dlg.getByRole('heading')).toHaveText('定稿成 V1');
    await expect(dlg).toContainText('字数');
    await expect(dlg.getByLabel('开头几行')).toContainText('甲端起酒杯。');
    await shot('02-finalize-dialog');
    await dlg.getByRole('button', { name: '确认定稿' }).click();
    await expect(dlg).toHaveCount(0);
    await expect(area()).toContainText('已定稿成 V1');
    assert.deepEqual((await historyItems()).map(t => LEGACY.test(t) ? '原稿存档' : t), ['V1', '原稿存档']);
    const post = fake.log.filter(l => l.verb === 'POST' && l.path.endsWith('/versions'));
    assert.equal(post.length, 1); assert.ok(post[0].token, '定稿带 X-Local-Token');
    await expect(area().getByLabel('剧本正文', { exact: true }).or(area().getByRole('document', { name: '剧本正文（阅读）' }))).toContainText('甲端起酒杯');
  });

  await check('定稿 409：草稿在确认前又改过 → 提示并换成最新草稿；超时重试用同一个 requestId', async () => {
    await area().getByLabel('剧本正文', { exact: true }).fill('## 场一\n甲端起酒杯。\n乙看向门口。\n第二稿。');
    await area().getByRole('button', { name: '保存剧本' }).click(); await expect(area().getByRole('button', { name: '保存剧本' })).toBeDisabled();
    await area().getByRole('button', { name: '定稿', exact: true }).click();
    const dlg = page.getByRole('dialog', { name: '定稿' }); await expect(dlg.getByRole('heading')).toHaveText('定稿成 V2');
    // 另一个窗口在这时又保存了一次草稿
    const now = await api(`/project-assets/projects/${ep.id}/script`);
    await api(`/project-assets/projects/${ep.id}/script`, { title: now.title, content: now.content + '\n别的窗口加的一行。', expected_revision: now.revision }, 'PUT');
    await dlg.getByRole('button', { name: '确认定稿' }).click();
    await expect(dlg).toContainText('草稿在你确认前又改过了，请重新看一眼再定');
    await expect(dlg.getByLabel('开头几行')).toContainText('别的窗口加的一行。');
    // 超时：再点一次用同一个 requestId，拿回原回执，不会多出一版
    fake.state.holdFinalize = true;
    await dlg.getByRole('button', { name: '确认定稿' }).click();
    await expect(dlg).toContainText('结果还没确认');
    await dlg.getByRole('button', { name: '确认定稿' }).click();
    await expect(dlg).toHaveCount(0);
    const ids = fake.log.filter(l => l.verb === 'POST' && l.path.endsWith('/versions'));
    assert.equal(ids.length, 4);
    assert.deepEqual((await historyItems()).map(t => LEGACY.test(t) ? '原稿存档' : t), ['V2', 'V1', '原稿存档']);
    // 页面上的输入没有被换掉（本地停在别的窗口改之前的内容——这正是让用户再看一眼的原因）
    await expect(area().getByLabel('剧本正文', { exact: true }).or(area().getByRole('document', { name: '剧本正文（阅读）' }))).toContainText('第二稿。');
  });

  await check('历史版本菜单的键盘（PR156 独验 P2-2）：打开焦点到第一项；↓↑ 循环、Home/End 到头尾；Enter 选中后焦点回到「历史版本」按钮；Esc 关上也回按钮', async () => {
    const menu = area().getByRole('menu', { name: '历史版本' }), items = menu.getByRole('menuitem');
    await historyButton().focus(); await page.keyboard.press('Enter');
    await expect(items).toHaveCount(3); await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowDown'); await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('End'); await expect(items.nth(2)).toBeFocused();
    await page.keyboard.press('ArrowDown'); await expect(items.nth(0)).toBeFocused();   // 到底再往下回到第一项
    await page.keyboard.press('ArrowUp'); await expect(items.nth(2)).toBeFocused();     // 第一项再往上到最后一项
    await page.keyboard.press('Home'); await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');           // 选 V1
    await expect(menu).toHaveCount(0); await expect(historyButton()).toBeFocused();
    await expect(area().getByLabel('当前看的是')).toContainText('正在看 V1（只读）');
    await page.keyboard.press('Enter'); await expect(items.nth(0)).toBeFocused();       // 按钮上回车再打开
    await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); await expect(historyButton()).toBeFocused();
    await page.keyboard.press('ArrowDown'); await expect(items.nth(0)).toBeFocused();   // 按钮上按 ↓ 也能打开
    await page.keyboard.press('Escape');
    await backToCurrent();
  });

  await check('历史版本菜单不越出窗口（PR156 独验 P2-2）：窗口宽 360–760 逐档打开，菜单整个在窗口里、页面不多出横向滚动', async () => {
    const menu = area().getByRole('menu', { name: '历史版本' });
    for (let w = 360; w <= 760; w += 10) {
      await page.setViewportSize({ width: w, height: 844 });
      await historyButton().click(); await expect(menu).toBeVisible();
      const box = await menu.boundingBox(), over = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - innerWidth, area: (el => el.scrollWidth - el.clientWidth)(document.querySelector('.sa-workspace')) }));
      assert.ok(box.x >= 0 && box.x + box.width <= w, `宽 ${w}：菜单在窗口里 ${JSON.stringify(box)}`);
      assert.ok(over.doc <= 0 && over.area <= 0, `宽 ${w}：没有横向滚动 ${JSON.stringify(over)}`);
      await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0);
    }
    await page.setViewportSize({ width: 390, height: 844 }); await historyButton().click(); await shot('01c-history-menu-390');
    await page.keyboard.press('Escape'); await page.setViewportSize({ width: 1440, height: 900 });
  });

  await check('请求工具：/project-scripts 一律带库请求头，写请求带本机令牌', async () => {
    assert.ok(fake.log.length > 0);
    for (const l of fake.log) assert.equal(l.libraryHeader, session.instanceId, l.verb + ' ' + l.path);
    for (const l of fake.log.filter(l => l.verb !== 'GET')) assert.ok(l.token, l.verb + ' ' + l.path);
  });

  await check('泳道图标签：列出这一集所有的图（不按版本筛）；每张写画在哪份稿子、和当前稿相同还是已经改过；数字是总数；点开整页看图', async () => {
    // 再挂一张图在 V2 上：V2 定稿后草稿没再改过，所以「和当前稿相同」
    const one = fake.state.maps.find(x => x.map.id === 'map-1'), v2 = fake.state.versions.find(v => v.versionNo === 2);
    fake.state.maps.push({ map: { ...one.map, id: 'map-3', title: '合成样例 · 单版（画在 V2 上）', createdAt: Date.now(), binding: { target: { kind: 'version', id: v2.id } }, isDraftStale: false },
      renderData: { ...one.renderData, binding: { target: { kind: 'version', id: v2.id, versionNo: 2, title: v2.title, displayLabel: 'V2', at: v2.finalizedAt } } }, issues: [] });
    await tab('泳道图').click();
    await expect(tab('泳道图')).toContainText('3');
    const cards = area().getByRole('button', { name: /^打开泳道图：/ });
    await expect(cards).toHaveCount(3);
    await expect(cards.filter({ hasText: '画在 V2' })).toContainText('画在 V2 · 和当前稿相同');
    await expect(area().getByRole('button', { name: '打开泳道图：合成样例 · 单版', exact: true })).toContainText(/画在 快照 #1 \d\d-\d\d \d\d:\d\d · 当前稿已经改过/);
    await expect(area().getByRole('button', { name: '打开泳道图：合成样例 · v1 到 v2 改动' })).toContainText(/画在 原稿存档（\d\d-\d\d） · 当前稿已经改过/);
    await expect(area()).not.toContainText('迁移');
    await expect(area()).not.toContainText('基于较早的草稿');
    const card = area().getByRole('button', { name: '打开泳道图：合成样例 · 单版', exact: true });
    await expect(card).toContainText('草稿图');
    await expect(card).toContainText('依据：合成剧本（单版用）'); await expect(card).toContainText('AI 补了 1 处'); await expect(card).toContainText('agent 画于');
    await expect(area().getByRole('link', { name: '泳道图试画页' })).toHaveCount(0); // 试画页给 agent 用，用户页面上不放链接
    await shot('03-maps-list');
    await card.click();
    await expect(area().locator('.sm-sheet svg')).toBeVisible();
    await expect(area()).toContainText('上传时的 1 条提醒');
    // 点 AI 补的框：依据原文按行号回填，带「为什么这样补」「拿不准的地方」
    await area().getByRole('button', { name: '线索与画面：毒在他杯里？' }).click();
    const pop = area().getByRole('dialog', { name: '原文' });
    await expect(pop).toContainText('AI 补的'); await expect(pop).toContainText('原文 L4'); await expect(pop).toContainText('乙（率先喝酒）');
    await expect(pop).toContainText('为什么这样补：'); await expect(pop).toContainText('拿不准的地方：');
    await shot('04-map-single-pop');
    await page.keyboard.press('Escape'); await expect(pop).toHaveCount(0);
    // 范围引用 L7–L8 显示两行
    await area().getByRole('button', { name: '丙：暗门走出质问甲' }).click();
    await expect(pop).toContainText('原文 L7–L8'); await expect(pop).toContainText('丙从暗门后走出。\n丙：你以为她会站在你那边？');
    await page.keyboard.press('Escape'); await expect(pop).toHaveCount(0);
    // 页面里的图跟着内容区铺开，不再按原始像素宽度靠左留白；标题和依据只出现一次
    const sheet = area().locator('.sa-map-scroll'), svgBox = await area().locator('.sm-board svg').boundingBox(), sheetBox = await sheet.boundingBox();
    const natural = Number((await area().locator('.sm-board svg').getAttribute('viewBox')).split(' ')[2]);
    assert.ok(svgBox.width > natural * 1.3, `图放大铺开：${svgBox.width} > ${natural}`);
    const leftGap = svgBox.x - sheetBox.x, rightGap = sheetBox.x + sheetBox.width - svgBox.x - svgBox.width;
    assert.ok(Math.abs(leftGap - rightGap) < 30, `居中，右边不留一大片白：左 ${leftGap}，右 ${rightGap}`);
    await expect(area().getByText('依据：合成剧本（单版用）')).toHaveCount(1);
    await expect(area().locator('.sm-title')).toHaveCount(1);
    await shot('04b-map-fit');
    await area().getByRole('button', { name: '← 返回泳道图列表' }).click();
  });

  await check('泳道图阅读模式：盖满窗口、焦点给「退出阅读」；细栏写标题和依据，图上不重复；按宽度缩放不横向滚动；点框弹卡片不出窗口；Esc 先关卡片再退出，焦点回到按钮', async () => {
    await readingModeWorks('线索与画面：毒在他杯里？', '04c-reading');
  });

  await check('改动图：删掉的框不画框和箭头，只留删除标记；没变的框写「新版原文」；原件删了写存档摘录', async () => {
    const card = area().getByRole('button', { name: '打开泳道图：合成样例 · v1 到 v2 改动' });
    await expect(card).toContainText(/改动 草稿快照 \d\d-\d\d \d\d:\d\d→原稿存档（\d\d-\d\d）/);
    await expect(card).toContainText('改了 5 处因果或动机，1 处措辞');
    await card.click();
    const svg = area().locator('.sm-sheet svg');
    await expect(svg).toBeVisible();
    await expect(svg.locator('[data-edge*="e3"]')).toHaveCount(0);
    await expect(area().getByRole('button', { name: /^删3：/ })).toBeVisible();
    await expect(area().getByRole('button', { name: '工头：撑不住也得撑' })).toHaveCount(0);
    await area().getByRole('button', { name: '小周：这墙撑不住' }).click();
    const pop = area().getByRole('dialog', { name: '原文' });
    await expect(pop).toContainText('新版原文 L6'); await expect(pop).not.toContainText('两版相同');
    await area().getByRole('button', { name: '小周：没拉住老李' }).click();
    await expect(pop).toContainText('原件已删除，以下为存档摘录');
    await expect(pop).toContainText(/草稿快照 \d\d-\d\d \d\d:\d\d 原文 L10/); await expect(pop).toContainText('小周拉住老李。');
    await expect(pop).toContainText(/原稿存档（\d\d-\d\d） 原文 L9/); await expect(pop).toContainText('小周没拉住老李。');
    await expect(area().locator('.sm-sub')).toContainText('合成剧本 v1（11-');
    await expect(area().locator('.sm-sub')).toContainText('原件已删除');
    await shot('05-map-diff-pop');
    await page.keyboard.press('Escape');
    await expect(area().locator('.sa-map-view-bar')).toContainText(/画在 原稿存档（\d\d-\d\d） · 当前稿已经改过/);
    await area().getByRole('button', { name: '← 返回泳道图列表' }).click();
    // 这一集没有图时：内容区上方一行提示，不居中留大片空白
    const saved = fake.state.maps; fake.state.maps = [];
    await tab('泳道图').click();
    const empty = area().locator('.sa-empty-line');
    await expect(empty).toHaveText('这一集还没有泳道图。泳道图由 agent 读剧本后画好传上来，这里只看不改。');
    const eb = await empty.boundingBox(), tabs = await area().getByRole('tablist', { name: '剧本区' }).boundingBox();
    assert.ok(eb.y - (tabs.y + tabs.height) < 40 && eb.height < 60, '空状态紧贴标签下方、只有一行：' + JSON.stringify(eb));
    await shot('05b-maps-empty');
    fake.state.maps = saved; await tab('泳道图').click(); await expect(tab('泳道图')).toContainText('3');
  });

  await check('分页（PR156 独验 P2-1）：版本超过 100 个时原稿存档在第二页也能在历史版本里打开；图超过 100 张时「再显示后面的」能看到并打开第 101 张', async () => {
    const savedVersions = fake.state.versions.slice(), savedMaps = fake.state.maps.slice(), now = Date.now();
    for (let n = 3; n <= 102; n++) fake.state.versions.push({ ...savedVersions.find(v => v.versionNo === 2), id: 'ver-' + n, versionNo: n, sourceId: 'src-ver-' + n, finalizedAt: now + n });
    const one = savedMaps.find(x => x.map.id === 'map-1');
    for (let n = 1; n <= 98; n++) fake.state.maps.push({ ...one, map: { ...one.map, id: 'extra-' + n, title: '合成批量图 ' + n, createdAt: now + n } });
    await page.reload(); await expect(area()).toBeVisible();
    await historyButton().click();
    const items = area().getByRole('menu', { name: '历史版本' }).getByRole('menuitem');
    await expect(items).toHaveCount(103);
    await expect(items.last()).toContainText(LEGACY);
    await items.last().click();
    await expect(area().getByLabel('当前看的是')).toContainText(/正在看 原稿存档（\d\d-\d\d）（只读）/);
    await expect(area().getByRole('document', { name: '剧本正文（只读）' })).toContainText('原稿的合成正文。');
    await backToCurrent();
    await tab('泳道图').click();
    await expect(tab('泳道图')).toContainText('101');
    const cards = area().getByRole('button', { name: /^打开泳道图：/ });
    await expect(cards).toHaveCount(100);
    await area().getByRole('button', { name: '再显示后面的 1 张' }).click();
    await expect(cards).toHaveCount(101);
    await area().getByRole('button', { name: '打开泳道图：合成样例 · 单版', exact: true }).click();   // 最早的那张，在第二页
    await expect(area().locator('.sm-sheet svg')).toBeVisible();
    await area().getByRole('button', { name: '← 返回泳道图列表' }).click();
    // 一直读不到一致的列表（每次读总数都在变）：保留上次正确的 101 张，给出「重试」，稳定后重试恢复
    fake.state.churnMaps = 1;
    await tab('泳道图').click();
    await expect(area().getByRole('alert')).toContainText('列表在读取的时候又有变化');
    await expect(cards).toHaveCount(101);
    const ids = await area().locator('[data-map-id]').evaluateAll(els => els.map(e => e.dataset.mapId)); assert.equal(new Set(ids).size, ids.length);
    fake.state.churnMaps = 0;
    await area().getByRole('alert').getByRole('button', { name: '重试' }).click();
    await expect(area().getByRole('alert')).toHaveCount(0); await expect(cards).toHaveCount(101);
    fake.state.versions = savedVersions; fake.state.maps = savedMaps;
    await page.reload(); await expect(area()).toBeVisible();
  });

  await check('甲方资料：默认挂本集；勾「放到全局资料」进全局组并标「全局」；上传走浏览器生成的 multipart 边界', async () => {
    await tab('甲方资料').click();
    const mats = area().getByRole('region', { name: '甲方资料' });
    await expect(mats).toContainText('本集还没有甲方资料'); await expect(mats).toContainText('还没有全局资料');
    const file = mats.getByLabel('选择要上传的甲方资料');
    await file.setInputFiles({ name: '文学稿.txt', mimeType: 'text/plain', buffer: Buffer.from('第一行\n\n第三行：合成文学稿。\n', 'utf8') });
    await mats.getByRole('button', { name: '上传', exact: true }).click();
    await expect(mats).toContainText('已上传「文学稿.txt」，挂在本集');
    await file.setInputFiles({ name: '人物小传.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 合成') });
    await mats.getByRole('checkbox', { name: /放到全局资料/ }).check();
    await mats.getByRole('button', { name: '上传', exact: true }).click();
    await expect(mats).toContainText('放在全局资料里');
    const lists = mats.locator('.sa-material-list');
    await expect(lists.nth(0)).toContainText('文学稿.txt'); await expect(lists.nth(1)).toContainText('人物小传.pdf'); await expect(lists.nth(1).locator('.sa-chip')).toHaveText('全局');
    await expect(tab('甲方资料')).toContainText('2');
    const uploads = fake.log.filter(l => l.verb === 'POST' && l.path.endsWith('/materials'));
    assert.equal(uploads.length, 2);
    for (const u of uploads) assert.match(u.contentType, /^multipart\/form-data; boundary=/);
    await shot('06-materials');
  });

  await check('甲方资料：TXT 页面里带行号预览（空行照计）；PDF 在新标签页打开；下载给原件', async () => {
    const mats = area().getByRole('region', { name: '甲方资料' });
    const txtRow = mats.locator('.sa-material', { hasText: '文学稿.txt' });
    await txtRow.getByRole('button', { name: '预览' }).click();
    const dlg = page.getByRole('dialog', { name: '预览：文学稿.txt' });
    await expect(dlg.locator('.sa-line-no')).toHaveText(['L1', 'L2', 'L3']);
    await expect(dlg).toContainText('第三行：合成文学稿。');
    await dlg.getByRole('button', { name: '关闭' }).click();
    const [popup] = await Promise.all([page.waitForEvent('popup'), mats.locator('.sa-material', { hasText: '人物小传.pdf' }).getByRole('button', { name: '在新标签页打开' }).click()]);
    assert.match(popup.url(), /disposition=inline&libraryId=/); await popup.close();
    await expect(txtRow.getByRole('link', { name: '下载' })).toHaveAttribute('href', /disposition=attachment&libraryId=/);
  });

  await check('甲方资料：DOCX 在页面里预览（docx-preview）；文档里的链接不跳转、不请求外部', async () => {
    const mats = area().getByRole('region', { name: '甲方资料' });
    await mats.getByLabel('选择要上传的甲方资料').setInputFiles({ name: '合成文学稿.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await syntheticDocx() });
    await mats.getByRole('button', { name: '上传', exact: true }).click();
    await expect(mats).toContainText('已上传「合成文学稿.docx」');
    await mats.locator('.sa-material', { hasText: '合成文学稿.docx' }).getByRole('button', { name: '预览' }).click();
    const doc = page.getByRole('document', { name: 'DOCX 预览：合成文学稿.docx' });
    await expect(doc).toContainText('合成 DOCX 第一段'); await expect(doc).toContainText('外部链接');
    assert.equal(await doc.locator('a[href]').count(), 0);
    await shot('06b-docx-preview');
    await page.getByRole('dialog', { name: '预览：合成文学稿.docx' }).getByRole('button', { name: '关闭' }).click();
  });

  await check('甲方资料：移到全局 / 移回本集提示剧级影响；删除全局资料提示所有集都看不到；版本冲突刷新列表', async () => {
    const mats = area().getByRole('region', { name: '甲方资料' });
    await mats.locator('.sa-material', { hasText: '文学稿.txt' }).getByRole('button', { name: '移到全局' }).click();
    let dlg = page.getByRole('alertdialog', { name: '移到全局资料' });
    await expect(dlg).toContainText('《合成剧》所有集都能看到');
    await dlg.getByRole('button', { name: '移到全局' }).click();
    await expect(mats).toContainText('已移到全局资料');
    await expect(mats.locator('.sa-material', { hasText: '文学稿.txt' }).locator('.sa-chip')).toHaveText('全局');
    // 别处改过：版本对不上 → 冲突提示，列表刷新
    fake.state.materials.find(m => m.originalFilename === '人物小传.pdf').revision += 5;
    await mats.locator('.sa-material', { hasText: '人物小传.pdf' }).getByRole('button', { name: '删除' }).click();
    dlg = page.getByRole('alertdialog', { name: '删除甲方资料' });
    await expect(dlg).toContainText('这是全局资料：删了以后所有集都看不到。');
    await expect(dlg).toContainText('原件删掉，泳道图里引用的那几句会留着');
    await dlg.getByRole('button', { name: '删除' }).click();
    await expect(mats).toContainText('这份资料刚被别处改过');
    await mats.locator('.sa-material', { hasText: '人物小传.pdf' }).getByRole('button', { name: '删除' }).click();
    await page.getByRole('alertdialog', { name: '删除甲方资料' }).getByRole('button', { name: '删除' }).click();
    await expect(mats).toContainText('已删除「人物小传.pdf」；泳道图里引用的 2 段摘录留着');
    await expect(mats).not.toContainText('人物小传.pdf' + 'PDF');
    await expect(tab('甲方资料')).toContainText('2');
  });

  await check('单独项目：甲方资料只有本集，没有「放到全局资料」', async () => {
    fake.state.projectIdBackup = fake.state.projectId;
    await selectProjectInBar(page, solo.id);
    await expect(area().getByRole('heading', { level: 1 })).toHaveText('单独短片');
    // 假后端只认那一集：单独项目的请求得到 404，界面要照常显示本集一组、不出全局
    const mats = area().getByRole('region', { name: '甲方资料' });
    await expect(mats.getByRole('checkbox', { name: /放到全局资料/ })).toHaveCount(0);
    await expect(mats.getByRole('heading', { name: /^全局/ })).toHaveCount(0);
    await selectProjectInBar(page, ep.id);
  });

  await check('「项目资产」里的「剧本」标签直接跳到侧栏「剧本」的同一集', async () => {
    await page.locator('.sidebar').getByRole('button', { name: /^项目资产/ }).click();
    const work = page.getByRole('region', { name: '项目资产库' });
    await work.getByRole('tab', { name: '剧本', exact: true }).click();
    await expect(page).toHaveURL(/#\/project-scripts$/);
    await expect(area()).toBeVisible();
    await expect(area().getByRole('heading', { level: 1 })).toContainText('合成剧');
    await expect(page.getByRole('region', { name: '项目剧本' }).first()).toBeVisible();
  });

  await check('试画页：独立整页；选 JSON 调 dry-run，成功画图并列出提醒；反例列出问题（含实际行号）并清掉旧图', async () => {
    const trial = await context.newPage(); trial.on('pageerror', e => errors.push(e.message));
    await trial.goto(origin + `/#/script-map-trial?project=${ep.id}&target=snapshot:snap-1`);
    const root = trial.locator('[data-trial-state]');
    await expect(root).toHaveAttribute('data-trial-state', 'idle');
    await expect(trial.locator('.sidebar')).toHaveCount(0);
    await expect(trial.getByLabel('项目')).toHaveValue(ep.id);
    await expect(trial.getByLabel('画在')).toHaveValue('snapshot:snap-1');
    await trial.getByLabel('选择泳道图 JSON').setInputFiles(path.join(fixtures, 'fixture_single.json'));
    await expect(root).toHaveAttribute('data-trial-state', 'ok');
    await expect(trial.locator('.sm-sheet svg')).toBeVisible();
    await expect(trial.getByRole('status')).toContainText('有 1 条提醒');
    await expect(trial.locator('.sa-issue.is-warning')).toContainText('合成提醒');
    const info = await trial.evaluate(() => window.__SCRIPT_MAP_TRIAL__);
    assert.equal(info.state, 'ok'); assert.ok(info.width > 400 && info.height > 300, JSON.stringify(info));
    const dry = fake.log.filter(l => l.path.endsWith('/maps/dry-run')).at(-1); assert.ok(dry.token && dry.libraryHeader === session.instanceId);
    await shot('07-trial-ok', trial);
    await trial.getByLabel('选择泳道图 JSON').setInputFiles(path.join(fixtures, 'fixture_bad_quote_off_by_one.json'));
    await expect(root).toHaveAttribute('data-trial-state', 'error');
    await expect(trial.getByRole('status')).toContainText('还要选前稿');
    await trial.getByLabel('前稿（改动图才要）').selectOption('legacy:legacy-1');
    await expect(trial.getByLabel('前稿（改动图才要）').locator('option:checked')).toHaveText(/^原稿存档（\d\d-\d\d）$/);
    await expect(trial.locator('body')).not.toContainText('迁移');
    await expect(root).toHaveAttribute('data-trial-state', 'invalid');
    await expect(trial.locator('.sm-sheet')).toHaveCount(0);
    await expect(trial.locator('.sa-issue.is-error')).toContainText('quote 对不上 L10');
    await expect(trial.locator('.sa-issue.is-error')).toContainText('这段话实际出现在：L9');
    await expect(trial.locator('.sa-issue-path')).toHaveText('graph.nodes[5].new[0].quote');
    assert.match(trial.url(), /before=legacy%3Alegacy-1|before=legacy:legacy-1/);
    await shot('08-trial-invalid', trial);
    // 结构错误（来源 key 重复）：本页用共享校验模块直接拦下，不发 dry-run
    const dryBefore = fake.state.dryRuns;
    await trial.getByLabel('选择泳道图 JSON').setInputFiles(path.join(fixtures, 'fixture_bad_dup_key.json'));
    await expect(root).toHaveAttribute('data-trial-state', 'invalid');
    await expect(trial.getByRole('status')).toContainText('还没发给拾光');
    await expect(trial.locator('.sa-issue.is-error').first()).toBeVisible();
    assert.equal(fake.state.dryRuns, dryBefore, '结构错误不发 dry-run');
    // 不是 JSON
    await trial.getByLabel('选择泳道图 JSON').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{not json') });
    await expect(root).toHaveAttribute('data-trial-state', 'error'); await expect(trial.getByRole('status')).toContainText('不是有效的 JSON');
    await trial.close();
  });

  await check('试画页：全新的浏览器（没有 Cookie、没开过主程序）直接打开就能试画，页面自己取本机会话', async () => {
    const fresh = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await fresh.route('**/api/project-scripts/**', route => fake.handle(route));
    assert.deepEqual(await fresh.cookies(), []);
    const trial = await fresh.newPage(); trial.on('pageerror', e => errors.push(e.message));
    const sessionReads = []; trial.on('request', r => { if (new URL(r.url()).pathname === '/api/session') sessionReads.push(r.url()); });
    const before = fake.log.length;
    await trial.goto(origin + `/#/script-map-trial?project=${ep.id}&target=snapshot:snap-1`);
    const rootEl = trial.locator('[data-trial-state]');
    await expect(rootEl).toHaveAttribute('data-trial-state', 'idle');
    await trial.getByLabel('选择泳道图 JSON').setInputFiles(path.join(fixtures, 'fixture_single.json'));
    await expect(rootEl).toHaveAttribute('data-trial-state', 'ok');
    assert.ok(sessionReads.length >= 1, '页面自己读了 /api/session');
    const dry = fake.log.slice(before).find(l => l.path.endsWith('/maps/dry-run'));
    assert.ok(dry && dry.token && dry.libraryHeader === session.instanceId, JSON.stringify(dry));
    await fresh.close();
  });

  await check('试画页：换文件时旧请求晚到的回包不会盖掉新的', async () => {
    const trial = await context.newPage(); trial.on('pageerror', e => errors.push(e.message));
    await trial.goto(origin + `/#/script-map-trial?project=${ep.id}&target=snapshot:snap-1&before=legacy:legacy-1`);
    const root = trial.locator('[data-trial-state]');
    fake.state.dryRunDelay = body => body.graph.kind === 'single' ? 1500 : 0;
    await trial.getByLabel('选择泳道图 JSON').setInputFiles(path.join(fixtures, 'fixture_single.json'));
    await expect(root).toHaveAttribute('data-trial-state', 'checking');
    await trial.getByLabel('选择泳道图 JSON').setInputFiles(path.join(fixtures, 'fixture_diff.json'));
    await expect(root).toHaveAttribute('data-trial-state', 'ok');
    await trial.waitForTimeout(1800);
    await expect(trial.locator('.sm-sheet')).toHaveAttribute('data-map-kind', 'diff');
    fake.state.dryRunDelay = null;
    await trial.close();
  });

  await check('新样子试用打开时：「项目」组里也有「剧本」，页面照常可用', async () => {
    await page.evaluate(() => localStorage.setItem('shiguang.paperTrial.v1', 'on'));
    await page.reload();
    const navItems = await page.locator('.sidebar').getByRole('button').allInnerTexts();
    assert.ok(navItems.some(t => t.trim() === '剧本'), JSON.stringify(navItems));
    await page.locator('.sidebar').getByRole('button', { name: '剧本', exact: true }).click();
    await expect(area()).toBeVisible();
    assert.deepEqual((await historyItems()).map(t => LEGACY.test(t) ? '原稿存档' : t), ['V2', 'V1', '原稿存档']);
    await shot('09-paper-trial');
    await tab('泳道图').click();
    await readingModeWorks('线索与画面：毒在他杯里？', '09b-paper-reading');
    await page.evaluate(() => localStorage.removeItem('shiguang.paperTrial.v1'));
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
