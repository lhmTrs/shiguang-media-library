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
const tab = name => area().getByRole('tablist', { name: '剧本区' }).getByRole('tab', { name: new RegExp('^' + name) });
const versions = () => area().getByRole('navigation', { name: '版本' });

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
    await expect(area().getByLabel('当前看的是')).toContainText('草稿');
  });

  await check('版本条：草稿｜迁移时的稿子（没有编号，样子不同）；旧稿只读', async () => {
    await expect(versions().getByRole('button')).toHaveText(['草稿正在改', '迁移时的稿子']);
    await expect(versions().getByRole('button', { name: '迁移时的稿子' })).toHaveClass(/sa-legacy/);
    await versions().getByRole('button', { name: '迁移时的稿子' }).click();
    await expect(area().getByLabel('当前看的是')).toHaveText('迁移时的稿子');
    await expect(area().getByRole('button', { name: '定稿', exact: true })).toHaveCount(0);
    await expect(area().getByRole('document', { name: '剧本正文（只读）' })).toContainText('迁移时的合成正文。');
    await expect(area().getByLabel('剧本正文', { exact: true })).toBeHidden();
    // 右栏照旧：本集出现的人物
    await expect(area().getByRole('complementary', { name: '剧本中出现的资产' }).last()).toContainText('甲');
    await shot('01-legacy-readonly');
    await versions().getByRole('button', { name: /^草稿/ }).click();
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

  await check('定稿对话框写清 V1、字数、最后保存时间和开头几行；确认后版本条出现 V1，草稿照旧', async () => {
    await area().getByRole('button', { name: '定稿', exact: true }).click();
    const dlg = page.getByRole('dialog', { name: '定稿' });
    await expect(dlg.getByRole('heading')).toHaveText('定稿成 V1');
    await expect(dlg).toContainText('字数');
    await expect(dlg.getByLabel('开头几行')).toContainText('甲端起酒杯。');
    await shot('02-finalize-dialog');
    await dlg.getByRole('button', { name: '确认定稿' }).click();
    await expect(dlg).toHaveCount(0);
    await expect(area()).toContainText('已定稿成 V1');
    await expect(versions().getByRole('button')).toHaveText(['草稿正在改', 'V1', '迁移时的稿子']);
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
    await expect(versions().getByRole('button')).toHaveText(['草稿正在改', 'V2', 'V1', '迁移时的稿子']);
    // 页面上的输入没有被换掉（本地停在别的窗口改之前的内容——这正是让用户再看一眼的原因）
    await expect(area().getByLabel('剧本正文', { exact: true }).or(area().getByRole('document', { name: '剧本正文（阅读）' }))).toContainText('第二稿。');
  });

  await check('请求工具：/project-scripts 一律带库请求头，写请求带本机令牌', async () => {
    assert.ok(fake.log.length > 0);
    for (const l of fake.log) assert.equal(l.libraryHeader, session.instanceId, l.verb + ' ' + l.path);
    for (const l of fake.log.filter(l => l.verb !== 'GET')) assert.ok(l.token, l.verb + ' ' + l.path);
  });

  await check('泳道图标签：草稿图卡片写类型、依据、画于何时、AI 补了几处，标「基于较早的草稿」；点开整页看图', async () => {
    await versions().getByRole('button', { name: /^草稿/ }).click();
    await tab('泳道图').click();
    await expect(tab('泳道图')).toContainText('1');
    const card = area().getByRole('button', { name: /^打开泳道图：/ });
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('草稿图'); await expect(card).toContainText('基于较早的草稿');
    await expect(card).toContainText('依据：合成剧本（单版用）'); await expect(card).toContainText('AI 补了 1 处'); await expect(card).toContainText('agent 画于');
    await expect(area().getByRole('link', { name: '泳道图试画页' })).toHaveAttribute('href', new RegExp('#/script-map-trial\\?project=' + ep.id));
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
    await area().getByRole('button', { name: '← 返回泳道图列表' }).click();
  });

  await check('改动图：删掉的框不画框和箭头，只留删除标记；没变的框写「新版原文」；原件删了写存档摘录', async () => {
    await versions().getByRole('button', { name: '迁移时的稿子' }).click();
    const card = area().getByRole('button', { name: /^打开泳道图：/ });
    await expect(card).toContainText(/改动 快照 #1 \d\d-\d\d \d\d:\d\d→快照 #2 \d\d-\d\d \d\d:\d\d/);
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
    await expect(pop).toContainText(/快照 #1 \d\d-\d\d \d\d:\d\d 原文 L10/); await expect(pop).toContainText('小周拉住老李。');
    await expect(pop).toContainText(/快照 #2 \d\d-\d\d \d\d:\d\d 原文 L9/); await expect(pop).toContainText('小周没拉住老李。');
    await expect(area().locator('.sm-sub')).toContainText('合成剧本 v1（11-');
    await expect(area().locator('.sm-sub')).toContainText('原件已删除');
    await shot('05-map-diff-pop');
    await page.keyboard.press('Escape');
    await area().getByRole('button', { name: '← 返回泳道图列表' }).click();
    await versions().getByRole('button', { name: /^草稿/ }).click();
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
    await expect(root).toHaveAttribute('data-trial-state', 'invalid');
    await expect(trial.locator('.sm-sheet')).toHaveCount(0);
    await expect(trial.locator('.sa-issue.is-error')).toContainText('quote 对不上 L10');
    await expect(trial.locator('.sa-issue.is-error')).toContainText('这段话实际出现在：L9');
    await expect(trial.locator('.sa-issue-path')).toHaveText('graph.nodes[5].new[0].quote');
    assert.match(trial.url(), /before=legacy%3Alegacy-1|before=legacy:legacy-1/);
    await shot('08-trial-invalid', trial);
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
    await expect(versions().getByRole('button', { name: 'V2' })).toBeVisible();
    await shot('09-paper-trial');
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
