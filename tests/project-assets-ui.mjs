import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { selectProjectInBar, showPublicAssets, projectInBar } from './helpers/path-bar.mjs';

const root = path.resolve(process.env.CREATIVE_TEST_PROJECT_ROOT || path.resolve(import.meta.dirname, '..')), evidence = path.resolve(process.env.CREATIVE_TEST_EVIDENCE || 'collab/results/PROJECT-ASSET-LIBRARY-20261104/browser');
await fs.mkdir(evidence, { recursive: true });
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-ui-')), images = path.join(temp, '合成照片'); await fs.mkdir(images);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');
for (let i = 1; i <= 3; i++) await fs.writeFile(path.join(images, '合成图片' + i + '.png'), png);
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false, closed = false; const checks = [], errors = [], external = [];
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_READONLY_FILES: '1', SHIGUANG_AUDIO_ANALYSIS: '0', MEDIA_DISABLE_DESKTOP_NATIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); assert.ok(response.ok, p + ' ' + JSON.stringify(data)); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const work = () => page.getByRole('region', { name: '项目资产库' });
const dialog = () => page.getByRole('dialog');
const nameInput = () => work().locator('.ca-name-input');
async function create(name) { await work().getByRole('button', { name: /^新建/ }).first().click(); await dialog().getByLabel('新资产名称').fill(name); await dialog().getByRole('button', { name: '创建并编辑' }).click(); await expect(nameInput()).toHaveValue(name); }
async function detailMenu(item) { await work().getByRole('button', { name: '资料操作', exact: true }).click(); await work().getByRole('menuitem', { name: item }).click(); }
async function openImage(index = 0) { await work().locator('.ca-tile-open').nth(index).click(); await expect(dialog()).toBeVisible(); }
async function closeImage() { await dialog().getByRole('button', { name: '关闭图片设置' }).click(); await expect(dialog()).toHaveCount(0); }
async function dropFiles(target, names) { await target.evaluate(async (node, list) => { const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII='), c => c.charCodeAt(0)); const data = new DataTransfer(); for (const n of list) data.items.add(new File([bytes], n, { type: n.endsWith('.png') ? 'image/png' : 'text/plain' })); for (const type of ['dragenter', 'dragover', 'drop']) node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data })); }, names); }
async function save() { await work().getByRole('button', { name: '保存资料', exact: true }).click(); await expect(work().getByRole('button', { name: '保存资料', exact: true })).toBeDisabled(); await expect(work().locator('.ca-alert')).toHaveCount(0); }
async function bind(index = 0) { const add = work().locator('details.ca-add-images'); if (!(await add.evaluate(d => d.open))) await add.locator('summary').first().click(); await work().getByRole('button', { name: '从素材库绑定图片', exact: true }).click(); await expect(dialog().locator('.ca-media-picker button')).toHaveCount(3); await dialog().locator('.ca-media-picker button').nth(index).click(); await expect(dialog()).toHaveCount(0); }
try {
 await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
 const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
 await check('HTTP本机会话、写入token和跨站边界', async () => {
  assert.equal((await fetch(origin + '/api/project-assets/scopes')).status, 401);
  assert.equal((await fetch(origin + '/api/project-assets/assets', { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json', 'x-local-token': 'invalid' }, body: '{}' })).status, 403);
  assert.equal((await fetch(origin + '/api/project-assets/scopes', { headers: { cookie, origin: 'http://127.0.0.1:1' } })).status, 403);
 });
 const a = await api('/projects', { name: '合成短剧甲' }), b = await api('/projects', { name: '合成短剧乙' });
 await api('/roots', { path: images, kind: 'photo' }); await expect.poll(async () => (await api('/jobs')).jobs.every(j => j.status !== 'running'), { timeout: 20000 }).toBe(true);
 browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
 const context = await browser.newContext({ viewport: { width: 1480, height: 1000 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
 context.on('request', r => { const u = new URL(r.url()); if (u.protocol.startsWith('http') && u.origin !== origin) external.push(u.origin + u.pathname); });
 page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(origin + '/#/project-assets'); await expect(work()).toBeVisible();
 await check('原生入口、项目选择和人物长文本保存', async () => {
  await selectProjectInBar(page, a.id); await create('陈川'); await work().getByLabel('基础信息', { exact: true }).fill('35岁，普通上班族。\n不改写用户剧情。'); await work().getByLabel('性格与表演', { exact: true }).fill('表达克制，先照顾别人。'); await save(); await page.reload(); await expect(work()).toBeVisible(); await selectProjectInBar(page, a.id); await work().locator('.ca-card').filter({ hasText: '陈川' }).click(); await expect(work().getByLabel('基础信息', { exact: true })).toHaveValue('35岁，普通上班族。\n不改写用户剧情。');
 });
 await check('多造型、参考职责、图片排序、默认代表图和头像裁切', async () => {
  await expect(work().locator('.ca-card')).toHaveCount(2); await work().getByRole('button', { name: '新增造型' }).click(); await work().locator('details.ca-look-config summary').click(); await work().getByLabel('造型名称', { exact: true }).fill('上班造型'); await work().getByLabel('造型类型（逗号分隔，可多选自定义）').fill('职业，日常'); await bind(); await bind(1); await openImage(0); await dialog().getByLabel('锁定内容', { exact: true }).fill('脸部、体态，保持角色辨识度'); await dialog().getByLabel('忽略内容', { exact: true }).fill('背景与图片文字'); await dialog().getByRole('button', { name: '图片后移' }).click(); await closeImage(); await save();
  await openImage(0); await dialog().locator('details.ca-crop summary').click(); await expect(dialog().locator('.ca-crop-box')).toBeVisible(); { /* 等裁切区按图片尺寸排好、拖角位置稳定后再拖，否则拖在旧坐标上 */ await expect(dialog().locator('.ca-cropper-stage')).toHaveAttribute('style', /width/); let last = ''; await expect.poll(async () => { const b = JSON.stringify(await dialog().locator('.ca-crop-handle.se').boundingBox()); const same = b === last; last = b; return same; }, { intervals: [100] }).toBe(true); const h = await dialog().locator('.ca-crop-handle.se').boundingBox(); await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await page.mouse.down(); await page.mouse.move(h.x - 60, h.y - 60, { steps: 6 }); await page.mouse.up(); } await expect.poll(async () => Number(await dialog().getByLabel('裁切zoom').inputValue()), { message: '拖角后缩放应大于 1' }).toBeGreaterThan(1); await dialog().getByLabel('裁切x').fill('30'); await closeImage(); await save(); await expect(work().locator('.ca-tile')).toHaveCount(2);
  await work().getByRole('button', { name: '新增造型' }).click(); await work().locator('details.ca-look-config summary').click(); await work().getByLabel('造型名称', { exact: true }).fill('家居造型'); await bind(2); await save(); await expect(work().locator('.ca-look-list')).toContainText('上班造型');
  await expect.poll(() => work().locator('.ca-tile-open img').first().evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  const saved = (await api('/project-assets/assets?project_id=' + a.id)).items[0], imageResponse = await fetch(origin + '/api/project-assets/bindings/' + saved.images[0].id + '/preview', { headers: { cookie } }); assert.equal(imageResponse.status, 200); assert.match(imageResponse.headers.get('content-type'), /^image\/png/);
  await page.screenshot({ path: path.join(evidence, 'character-looks.png'), fullPage: true });
 });
 let original;
 await check('跨项目复制可改名，默认关系保留，副本独立', async () => {
  original = (await api('/project-assets/assets?project_id=' + a.id)).items[0];
  await detailMenu('复制到其他项目'); await dialog().getByLabel('目标项目').selectOption(b.id); await dialog().getByLabel('复制后人物名称').fill('陈川乙'); await dialog().getByRole('button', { name: '确认复制', exact: true }).click(); await expect(dialog()).toHaveCount(0);
  // 顶栏统一：复制到别的项目不替用户切项目，留在原处提示；从顶栏切过去再打开副本
  await expect(work()).toContainText('在顶部切到该项目即可查看'); await expect(projectInBar(page)).toHaveAttribute('data-project', a.id); await expect(nameInput()).toHaveValue('陈川');
  await selectProjectInBar(page, b.id); await work().locator('.ca-card').filter({ hasText: '陈川乙' }).click(); await expect(nameInput()).toHaveValue('陈川乙');
  const copy = (await api('/project-assets/assets?project_id=' + b.id)).items[0]; assert.notEqual(copy.id, original.id); assert.equal(copy.images[0].media_asset_id, original.images[0].media_asset_id); assert.equal(copy.looks.length, 2); assert.equal(copy.source.asset_id, original.id);
  await work().getByLabel('人物名称').fill('副本独立修改'); await save(); assert.equal((await api('/project-assets/assets/' + original.id)).name, '陈川');
 });
 await check('公共人物创建和复制、名称冲突明确可见', async () => {
  const scopes = (await api('/project-assets/scopes')).items, pub = scopes.find(p => p.project_kind === 'public'); await selectProjectInBar(page, a.id); await showPublicAssets(page); // 当前项目是甲：复制到甲时在页内打开副本 await create('公共角色'); await detailMenu('复制到其他项目'); await dialog().getByLabel('目标项目').selectOption(a.id); await dialog().getByLabel('复制后人物名称').fill('陈川'); await dialog().getByRole('button', { name: '确认复制', exact: true }).click(); await expect(work().getByRole('alert').first()).toContainText('同名'); await dialog().getByLabel('复制后人物名称').fill('公共角色副本'); await dialog().getByRole('button', { name: '确认复制', exact: true }).click(); await expect(dialog()).toHaveCount(0); await expect(nameInput()).toHaveValue('公共角色副本');
 });
 await check('两个编辑版本发生冲突时保留本地输入', async () => {
  const current = (await api('/project-assets/assets?project_id=' + a.id)).items.find(a => a.name === '公共角色副本'); const changed = await api('/project-assets/assets/' + current.id, { asset: { ...current, base_info: '后台新版本' }, expected_revision: current.revision }, 'PUT');
  await work().getByLabel('基础信息', { exact: true }).fill('本地尚未保存文字'); await work().getByRole('button', { name: '保存资料', exact: true }).click(); await expect(work().locator('.ca-conflict')).toContainText('人物已经更新'); await expect(work().getByLabel('基础信息', { exact: true })).toHaveValue('本地尚未保存文字');
  assert.equal(changed.base_info, '后台新版本'); page.once('dialog', d => d.accept()); await work().getByRole('button', { name: '载入最新资料' }).click(); await expect(work().getByLabel('基础信息', { exact: true })).toHaveValue('后台新版本'); await work().getByLabel('基础信息', { exact: true }).fill('冲突已核对'); await save();
 });
 await check('画廊不自动选中、关闭详情、放弃修改', async () => {
  await selectProjectInBar(page, b.id); await selectProjectInBar(page, a.id); await expect(work().locator('.ca-card').first()).toBeVisible(); await expect(work().locator('.ca-detail')).toHaveCount(0);
  await work().locator('.ca-card').filter({ hasText: '陈川' }).first().click(); await work().getByLabel('基础信息', { exact: true }).fill('临时输入'); await expect(work().locator('.ca-savebar')).toContainText('有未保存的修改');
  page.once('dialog', d => d.accept()); await work().getByRole('button', { name: '放弃修改' }).click(); await expect(work().getByLabel('基础信息', { exact: true })).toHaveValue('35岁，普通上班族。\n不改写用户剧情。'); await expect(work().getByRole('button', { name: '保存资料', exact: true })).toBeDisabled();
  await work().getByRole('button', { name: '关闭详情' }).click(); await expect(work().locator('.ca-detail')).toHaveCount(0);
 });
 await check('场景和道具基础资料、图片、归档与恢复', async () => {
  for (const [tab, name] of [['场景','家中厨房'],['道具','工作包']]) { await work().getByRole('tab', { name: tab, exact: true }).click(); await create(name); await work().getByLabel('自由描述').fill('合成资料，不涉及剧情场次。'); await save(); await bind(); await save(); await detailMenu('归档'); await expect(work().locator('.ca-archive-note')).toBeVisible(); await detailMenu('恢复'); await expect(work().locator('.ca-archive-note')).toHaveCount(0); }
 });
 await check('从访达拖入图片：新建弹窗、只读目录失败可归档、拖到人物卡片选择造型', async () => {
  // 本测试实例以 MEDIA_READONLY_FILES=1 启动，导入会被拒绝；这里验证流程与失败处理，成功导入在独立实例上人工核对。
  await work().getByRole('tab', { name: '场景', exact: true }).click(); await expect(work().locator('.ca-detail')).toHaveCount(0);
  await dropFiles(work().locator('.ca-gallery'), ['拖入的街角.png', '说明.txt']); await expect(dialog()).toContainText('用 1 张图片新建场景'); await expect(dialog().getByLabel('名称：拖入的街角.png')).toHaveValue('拖入的街角'); await dialog().getByRole('button', { name: /^新建 1 个场景/ }).click();
  await expect(dialog().locator('.ca-drop-list li')).toContainText('资料已建立'); await dialog().getByRole('button', { name: '归档刚建立的资料' }).click(); await expect(dialog().locator('.ca-drop-list li')).toContainText('已归档刚建立的资料'); await dialog().getByRole('button', { name: '完成', exact: true }).click(); await expect(dialog()).toHaveCount(0);
  await expect(work().locator('.ca-card').filter({ hasText: '拖入的街角' })).toHaveCount(0);
  await work().getByRole('tab', { name: '人物', exact: true }).click(); await dropFiles(work().locator('.ca-card').filter({ hasText: '陈川' }).first(), ['补充参考.png']); await expect(dialog()).toContainText('添加到“陈川”'); await expect(dialog().getByLabel('放进造型')).toBeVisible();
  await dialog().getByLabel('放进造型').selectOption({ label: '家居造型' }); await dialog().getByRole('button', { name: '添加图片' }).click(); await expect(dialog().locator('.ca-drop-list li')).toContainText('未完成'); await dialog().getByRole('button', { name: '取消', exact: true }).click(); await expect(dialog()).toHaveCount(0);
 });
 await check('剧本三栏：场次大纲跳转与出现的资产', async () => {
  await work().getByRole('tab', { name: '剧本', exact: true }).click(); const body = work().getByLabel('剧本正文'); await expect(body).toBeEnabled();
  await body.fill('1. 家中厨房 早晨\n陈川拿起工作包。\n\n2. 街角 傍晚\n陈川走过拖入的街角。'); await expect(work().getByRole('navigation', { name: '场次大纲' }).getByRole('button')).toHaveCount(2);
  await work().getByRole('navigation', { name: '场次大纲' }).getByRole('button', { name: /^2\./ }).click(); assert.ok(await body.evaluate(t => t.selectionStart > 0));
  const mentions = work().getByRole('complementary', { name: '剧本中出现的资产' }); await expect(mentions.locator('li').filter({ hasText: '陈川' })).toContainText('2 次'); await expect(mentions.locator('li').filter({ hasText: '工作包' })).toContainText('1 次');
  await work().getByRole('button', { name: '保存剧本' }).click(); await expect(work().getByRole('button', { name: '保存剧本' })).toBeDisabled(); await work().getByRole('tab', { name: '人物', exact: true }).click();
 });
 await check('主题、手机布局、刷新路由与原分镜入口兼容', async () => {
  for (const theme of ['forest','dark','midnight']) { await page.evaluate(t => document.documentElement.dataset.theme = t, theme); await page.screenshot({ path: path.join(evidence, 'assets-' + theme + '.png'), fullPage: true }); }
  for (const width of [1440,1024,768,390,320]) { await page.setViewportSize({ width, height: 900 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no overflow at ' + width); }
  await page.screenshot({ path: path.join(evidence, 'assets-mobile.png'), fullPage: true }); await page.reload(); await expect(work()).toBeVisible(); await page.goto(origin + '/#/storyboards'); await expect(page.getByRole('region', { name: '分镜设计工作台' })).toBeVisible(); await page.goto(origin + '/#/project-assets'); await expect(work()).toBeVisible(); assert.deepEqual(errors, []); assert.deepEqual(external, []);
 });
 passed = true;
} catch (e) { if (page) await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true }).catch(() => {}); await fs.writeFile(path.join(evidence, 'failure.txt'), e.stack); throw e; }
finally {
 await browser?.close();
 if (child.exitCode === null && !child.signalCode) child.kill('SIGTERM');
 let timer; try { await Promise.race([exited, new Promise((_, reject) => timer = setTimeout(() => reject(Error('Owned app did not exit')), 15000))]); } finally { clearTimeout(timer); }
 closed = logs.includes('APPLICATION_CLOSED_KNOWN');
 assert.ok(closed, 'APPLICATION_CLOSED_KNOWN'); await fs.writeFile(path.join(evidence, 'server.log'), logs); await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify({ passed, checks, errors, external, closed, temp }, null, 2));
 if (passed && closed) await fs.rm(temp, { recursive: true, force: true });
}
