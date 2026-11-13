// 项目资产图片多选与批量复制（原图文件进系统剪贴板 / 在访达中显示）的界面检查。
// 后端图片桌面接口（feat/codex-assets-multicopy）未合入前，用 page.route 按已确认合同模拟：
// desktop-capabilities、images/clipboard、images/reveal/preview、images/reveal、desktop-actions/:id。
// 其余走真实本地服务和合成图片；不触碰真实剪贴板、访达和素材库。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { selectProjectInBar } from './helpers/path-bar.mjs';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-multicopy-')), images = path.join(temp, '合成照片'); await fs.mkdir(images);
const ffmpeg = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
for (const [name, color] of [['泳衣正面.png', 'red'], ['泳衣侧面.png', 'blue'], ['日常.png', 'green']]) {
  const run = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=300x400`, '-frames:v', '1', path.join(images, name)]);
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
const status = () => page.locator('.ca-desktop-status');
const asset = id => api('/project-assets/assets/' + id);
const mock = { caps: { version: 1, maxSelection: 50, clipboard: { available: true }, revealMany: { available: true } }, posts: [], receipts: new Map(), dropNextClipboard: false, skipLast: false, folders: 1, gets: 0 };
const shot = async name => { if (process.env.MULTICOPY_SHOTS) await page.screenshot({ path: path.join(process.env.MULTICOPY_SHOTS, name + '.png') }); };
const posts = kind => mock.posts.filter(p => p.kind === kind);
async function installMocks() {
  await page.route('**/api/project-assets/projects/*/desktop-capabilities', route => route.fulfill({ json: mock.caps }));
  await page.route('**/api/project-assets/projects/*/images/clipboard', async route => {
    const body = route.request().postDataJSON(); mock.posts.push({ kind: 'clipboard', body });
    const items = body.items, skipped = mock.skipLast && items.length > 1 ? [{ bindingId: items.at(-1).bindingId, name: '最后一张', code: 'CONTENT_CHANGED', reason: '原图内容已变化' }] : [];
    const copied = items.filter(i => !skipped.some(s => s.bindingId === i.bindingId)).map(i => ({ bindingId: i.bindingId, name: i.bindingId.slice(0, 4) }));
    const receipt = { requestId: body.requestId, action: 'clipboard', status: skipped.length ? 'partial' : 'completed', requestedCount: items.length, count: copied.length, copied, skipped, ack: 'written' };
    mock.receipts.set(body.requestId, receipt);
    if (mock.dropNextClipboard) { mock.dropNextClipboard = false; return route.abort('failed'); }
    await route.fulfill({ json: receipt });
  });
  await page.route('**/api/project-assets/projects/*/images/reveal/preview', async route => {
    const body = route.request().postDataJSON(); mock.posts.push({ kind: 'reveal-preview', body });
    const folders = Array.from({ length: mock.folders }, (_, i) => ({ key: 'f' + i, label: '项目文件夹 ' + (i + 1), count: 1 }));
    await route.fulfill({ json: { requestId: body.requestId, action: 'reveal-preview', status: 'completed', previewToken: 'tok-' + body.requestId.slice(0, 6), folderCount: mock.folders, folders, eligible: body.items.map(i => ({ bindingId: i.bindingId })), skipped: [] } });
  });
  await page.route('**/api/project-assets/projects/*/images/reveal', async route => {
    const body = route.request().postDataJSON(); mock.posts.push({ kind: 'reveal', body });
    await route.fulfill({ json: { requestId: body.requestId, action: 'reveal', status: 'completed', ack: 'dispatched', requested: body.items.map(i => ({ bindingId: i.bindingId })), count: body.items.length, skipped: [] } });
  });
  await page.route('**/api/project-assets/projects/*/desktop-actions/*', async route => {
    mock.gets++; const id = decodeURIComponent(route.request().url().split('/').pop()); const r = mock.receipts.get(id);
    await route.fulfill(r ? { json: r } : { status: 404, json: { error: '没有这笔请求', code: 'NOT_FOUND' } });
  });
}

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  const project = await api('/projects', { name: '多选复制短片' });
  await api('/roots', { path: images, kind: 'photo' }); await expect.poll(async () => (await api('/jobs')).jobs.every(j => j.status !== 'running'), { timeout: 20000 }).toBe(true);
  const listed = await api('/assets?kind=photo'), media = Object.fromEntries((listed.assets ?? listed.items).map(m => [m.name, m]));
  const bind = (id, look, file) => ({ id, look_id: look, media_asset_id: media[file].id, reference_type: '人物身份', purpose: '', locks: '', ignores: '', confirmed: true, archived_at: null, crop: { x: 50, y: 50, zoom: 1 }, last_known_name: file });
  const make = async (name, files) => {
    let a = await api('/project-assets/assets', { project_id: project.id, kind: 'character', name });
    const swim = crypto.randomUUID(), daily = crypto.randomUUID(), ids = files.map(() => crypto.randomUUID());
    a = await api('/project-assets/assets/' + a.id, { asset: { ...a, default_look_id: swim,
      looks: [{ id: swim, name: '泳衣', description: '', tags: [], default_image_id: ids[0], archived_at: null }, { id: daily, name: '日常', description: '', tags: [], default_image_id: ids.at(-1), archived_at: null }],
      images: files.map((f, i) => bind(ids[i], i === files.length - 1 ? daily : swim, f)) }, expected_revision: a.revision }, 'PUT');
    return { a, ids, swim, daily };
  };
  const hero = await make('阿青', ['泳衣正面.png', '泳衣侧面.png', '日常.png']);
  const second = await make('小满', ['泳衣侧面.png', '日常.png']);
  await api('/project-assets/assets', { project_id: project.id, kind: 'character', name: '苏禾' });
  const rev = (who, i) => who.a.images.find(b => b.id === who.ids[i]).revision;

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0')); await context.addInitScript(() => { window.__clipWrites = 0; const c = navigator.clipboard; if (c?.write) { const w = c.write.bind(c); c.write = (...a) => { window.__clipWrites++; return w(...a); }; } });
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await installMocks();
  await page.goto(origin + '/#/project-assets'); await expect(work()).toBeVisible(); await selectProjectInBar(page, project.id);
  await expect(wrap('阿青')).toBeVisible(); await expect(wrap('小满')).toBeVisible();

  await check('人物列表和视频页同一套选法：单击只选一个并打开详情，⌘ 点加选后详情换成已选清单；没有勾选框；复制按每人默认图发出原图文件请求', async () => {
    await expect(work().locator('.ca-card-wrap [role=checkbox]')).toHaveCount(0);
    await wrap('阿青').locator('.ca-card').click(); await expect(work().getByLabel('基础信息', { exact: true })).toBeVisible();
    const bar = work().getByRole('toolbar', { name: '已选人物操作' }); await expect(bar).toHaveCount(0);
    await wrap('小满').locator('.ca-card').click({ modifiers: ['Meta'] }); await expect(bar).toContainText('已选 2 个人物');
    const summary = work().getByRole('complementary', { name: '已选人物' }); await expect(summary).toContainText('阿青'); await expect(summary).toContainText('小满');
    await expect(work().getByLabel('基础信息', { exact: true })).toHaveCount(0);
    await wrap('苏禾').locator('.ca-card').click({ modifiers: ['Meta'] }); await expect(page.getByText('「苏禾」还没有默认图，不能选').first()).toBeVisible(); await expect(bar).toContainText('已选 2 个人物');
    await bar.getByRole('button', { name: '复制' }).click();
    await expect(status()).toContainText('已复制 2 张原图文件，到画布平台按 ⌘V 粘贴'); await shot('1-gallery');
    const b = posts('clipboard')[0].body;
    assert.equal(b.mode, 'defaults'); assert.match(b.requestId, /^[0-9a-f-]{36}$/);
    // Picks go out in the order the cards are shown (same as the video page), not click order.
    const shown = await work().locator('.ca-card-wrap strong').allTextContents(), want = { 阿青: { bindingId: hero.ids[0], bindingRevision: rev(hero, 0) }, 小满: { bindingId: second.ids[0], bindingRevision: rev(second, 0) } };
    assert.deepEqual(b.items, shown.filter(n => want[n]).map(n => want[n]));
    // A plain click drops the multi-pick and shows just that one.
    await wrap('小满').locator('.ca-card').click(); await expect(bar).toHaveCount(0); await expect(work().getByLabel('基础信息', { exact: true })).toBeVisible();
    await expect(work().locator('.ca-card-wrap.is-picked')).toHaveCount(0);
  });

  await check('框选、Shift 连选、⌘A、⌘C、Esc、右键作用于已选；有未保存修改时先确认，取消就什么都不变', async () => {
    const gallery = work().getByRole('region', { name: '人物画廊' }), bar = work().getByRole('toolbar', { name: '已选人物操作' });
    const g = await gallery.boundingBox(), a = await wrap('阿青').boundingBox(), b = await wrap('小满').boundingBox();
    const top = Math.min(a.y, b.y) + 12, endX = Math.max(a.x + a.width / 2, b.x + b.width / 2), endY = Math.max(a.y + a.height / 2, b.y + b.height / 2);
    const drag = async () => { await page.mouse.move(g.x + 8, top); await page.mouse.down(); await page.mouse.move(g.x + 40, top + 30, { steps: 3 }); await page.mouse.move(endX, endY, { steps: 6 }); await page.mouse.up(); };
    // 小满's detail is open; make it dirty, then a box asks first. Dismiss → nothing changes and the edit stays.
    const name = work().getByLabel('人物名称'); await name.fill('小满（改）');
    page.once('dialog', d => d.dismiss()); await drag();
    await expect(bar).toHaveCount(0); await expect(name).toHaveValue('小满（改）');
    page.once('dialog', d => d.accept()); await drag();
    await expect(bar).toContainText('已选 2 个人物'); await expect(work().getByLabel('人物名称')).toHaveCount(0); await shot('3-marquee');
    // Right-click a picked card: the menu acts on all picks; single-only actions are off.
    await wrap('阿青').click({ button: 'right' }); const menu = page.getByRole('menu', { name: '已选 2 个人物的操作' });
    await expect(menu.getByRole('menuitem', { name: /换默认图/ })).toBeDisabled(); await expect(menu.getByRole('menuitem', { name: /调整头像/ })).toBeDisabled();
    let n = posts('clipboard').length; await menu.getByRole('menuitem', { name: /复制 2 张默认图/ }).click();
    await expect.poll(() => posts('clipboard').length).toBe(n + 1); assert.deepEqual(new Set(posts('clipboard').at(-1).body.items.map(i => i.bindingId)), new Set([hero.ids[0], second.ids[0]]));
    // ⌘C copies the same picks (once the previous copy has finished).
    await expect(bar.getByRole('button', { name: '复制' })).toBeEnabled(); n = posts('clipboard').length; await page.keyboard.press('Meta+c'); await expect.poll(() => posts('clipboard').length).toBe(n + 1);
    assert.equal(posts('clipboard').at(-1).body.items.length, 2);
    // Right-click an unpicked card drops the multi-pick and shows that card's own menu.
    await wrap('苏禾').click({ button: 'right' }); await expect(page.getByRole('menu', { name: '苏禾的操作' })).toBeVisible(); await expect(bar).toHaveCount(0);
    await page.keyboard.press('Escape');
    // Shift picks the run from the clicked one; a click on empty space clears.
    await wrap('阿青').locator('.ca-card').click(); await wrap('小满').locator('.ca-card').click({ modifiers: ['Shift'] }); await expect(bar).toContainText('已选 2 个人物');
    await page.mouse.click(g.x + 8, top); await expect(bar).toHaveCount(0);
    // ⌘A picks every shown character that has a default image; Esc leaves.
    await page.keyboard.press('Meta+a'); await expect(bar).toContainText('已选 2 个人物'); await expect(wrap('苏禾')).not.toHaveClass(/is-picked/);
    await page.keyboard.press('Escape'); await expect(bar).toHaveCount(0);
  });

  await check('FE1-R2 反例：框住两张卡片顶部后再小幅拖动，拖动中只高亮、布局不动，松手两张都选上', async () => {
    const bar = work().getByRole('toolbar', { name: '已选人物操作' });
    await expect(work().getByLabel('人物名称')).toHaveCount(0); await expect(bar).toHaveCount(0);
    const gallery = work().getByRole('region', { name: '人物画廊' }), g = await gallery.boundingBox(), a = await wrap('阿青').boundingBox(), b = await wrap('小满').boundingBox();
    const top = Math.min(a.y, b.y), right = Math.max(a.x + a.width, b.x + b.width);
    await page.mouse.move(g.x + 8, top - 6); await page.mouse.down(); await page.mouse.move(g.x + 40, top + 4, { steps: 3 }); await page.mouse.move(right - 20, top + 14, { steps: 6 });
    await expect(wrap('阿青')).toHaveClass(/is-picked/); await expect(wrap('小满')).toHaveClass(/is-picked/); await expect(bar).toHaveCount(0);
    const moved = await wrap('阿青').boundingBox(); assert.deepEqual([Math.round(moved.x), Math.round(moved.y)], [Math.round(a.x), Math.round(a.y)], 'cards stay put while dragging');
    await page.mouse.move(right - 16, top + 18, { steps: 2 }); await page.mouse.up();
    await expect(bar).toContainText('已选 2 个人物');
    // Right after a box, ⌘C copies (focus is on the gallery).
    await expect(bar.getByRole('button', { name: '复制' })).toBeEnabled(); let n = posts('clipboard').length;
    await page.keyboard.press('Meta+c'); await expect.poll(() => posts('clipboard').length).toBe(n + 1);
    await page.keyboard.press('Escape'); await expect(bar).toHaveCount(0);
  });

  await check('FE2-R3 反例：焦点离开人物画廊（顶部「检查文件状态」）时 ⌘C、⌘A 不动作；回到画廊后 ⌘C 正常复制', async () => {
    const bar = work().getByRole('toolbar', { name: '已选人物操作' }), gallery = work().getByRole('region', { name: '人物画廊' });
    await wrap('阿青').locator('.ca-card').click(); await wrap('小满').locator('.ca-card').click({ modifiers: ['Meta'] }); await expect(bar).toContainText('已选 2 个人物');
    await expect(bar.getByRole('button', { name: '复制' })).toBeEnabled();
    const outside = page.getByRole('button', { name: '检查文件状态' }); await outside.focus();
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.ca-gallery')), false, 'focus left the gallery');
    const n = posts('clipboard').length;
    await page.keyboard.press('Meta+c'); await page.waitForTimeout(400); assert.equal(posts('clipboard').length, n, 'no copy from outside the gallery');
    await expect(bar).toContainText('已选 2 个人物');
    await gallery.focus(); await page.keyboard.press('Meta+c'); await expect.poll(() => posts('clipboard').length).toBe(n + 1);
    await page.keyboard.press('Escape'); await expect(bar).toHaveCount(0);
    await outside.focus(); await page.keyboard.press('Meta+a'); await page.waitForTimeout(300); await expect(bar).toHaveCount(0);
  });

  await check('FE1-R1 反例：未保存时 ⌘ 点或单击换人被取消，选择、详情和 Shift 起点都不变；再 Shift 点确认后选中两人', async () => {
    const bar = work().getByRole('toolbar', { name: '已选人物操作' }), name = work().getByLabel('人物名称');
    for (const how of [['Meta'], []]) {
      await wrap('阿青').locator('.ca-card').click(); await expect(name).toHaveValue('阿青');
      await name.fill('阿青（改）');
      page.once('dialog', d => d.dismiss()); await wrap('小满').locator('.ca-card').click({ modifiers: how });
      await expect(name).toHaveValue('阿青（改）'); await expect(bar).toHaveCount(0);
      page.once('dialog', d => d.accept()); await wrap('小满').locator('.ca-card').click({ modifiers: ['Shift'] });
      await expect(bar).toContainText('已选 2 个人物'); await expect(name).toHaveCount(0);
      await page.keyboard.press('Escape'); await expect(bar).toHaveCount(0);
    }
    await wrap('小满').locator('.ca-card').click(); await expect(work().getByLabel('基础信息', { exact: true })).toBeVisible();
  });

  await check('卡片上的单张「复制」也走原图文件；部分跳过写明原因', async () => {
    await wrap('阿青').hover(); await wrap('阿青').getByRole('button', { name: '复制阿青的默认图' }).click();
    await expect(status()).toContainText('已复制 1 张原图文件');
    assert.deepEqual(posts('clipboard').at(-1).body.items, [{ bindingId: hero.ids[0], bindingRevision: rev(hero, 0) }]);
    mock.skipLast = true;
    // 小满's detail is open, so ⌘ on 阿青 makes two.
    await wrap('阿青').locator('.ca-card').click({ modifiers: ['Meta'] }); await expect(work().getByRole('toolbar', { name: '已选人物操作' })).toContainText('已选 2 个人物');
    await work().getByRole('toolbar', { name: '已选人物操作' }).getByRole('button', { name: '复制' }).click();
    await expect(status()).toContainText('已复制 1 张原图文件'); await expect(status()).toContainText('跳过 1 张：最后一张：原图内容已变化');
    mock.skipLast = false; await page.keyboard.press('Escape');
  });

  await check('详情参考图：⌘ 点进入多选，可跨造型；复制按 references；多文件夹先确认再打开访达', async () => {
    await wrap('阿青').locator('.ca-card').click(); await expect(work().getByLabel('基础信息', { exact: true })).toBeVisible();
    const tile = name => work().locator('.ca-tile').filter({ hasText: name });
    await tile('泳衣侧面.png').locator('.ca-tile-open').click({ modifiers: ['Meta'] });
    const bar = work().getByRole('toolbar', { name: '已选参考图操作' }); await expect(bar).toContainText('已选 1 张');
    await tile('泳衣正面.png').locator('.ca-tile-open').click(); await expect(bar).toContainText('已选 2 张');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await work().getByRole('button', { name: /日常/ }).first().click();
    await tile('日常.png').locator('.ca-tile-open').click(); await expect(bar).toContainText('已选 3 张'); await expect(bar).toContainText('含其他造型 2 张');
    await bar.getByRole('button', { name: '复制' }).click(); await expect(status()).toContainText('已复制 3 张原图文件'); await shot('2-refs');
    const b = posts('clipboard').at(-1).body; assert.equal(b.mode, 'references'); assert.deepEqual(new Set(b.items.map(i => i.bindingId)), new Set(hero.ids));
    mock.folders = 2;
    await bar.getByRole('button', { name: '在访达中显示' }).click();
    const ask = page.getByRole('dialog', { name: '在访达中显示所选图片' }); await expect(ask).toContainText('会打开 2 个访达窗口');
    assert.equal(posts('reveal').length, 0, 'nothing opened before confirming');
    await ask.getByRole('button', { name: '打开' }).click(); await expect(status()).toContainText('已请求在访达中显示 3 张');
    assert.match(posts('reveal')[0].body.previewToken, /^tok-/); assert.equal(posts('reveal')[0].body.mode, 'references');
    mock.folders = 1;
  });

  await check('回应丢失：只能查询原请求，不会重发；本机能力不可用或还没读到时，多选按钮和人物单张两个入口都说明原因，不写 PNG、不显示成功', async () => {
    const bar = work().getByRole('toolbar', { name: '已选参考图操作' });
    mock.dropNextClipboard = true; const before = posts('clipboard').length;
    await bar.getByRole('button', { name: '复制' }).click();
    await expect(status()).toContainText('结果尚未确认'); await expect(bar.getByRole('button', { name: '复制' })).toBeDisabled();
    await status().getByRole('button', { name: '查询原请求' }).click(); await expect(status()).toContainText('已复制 3 张原图文件');
    assert.equal(posts('clipboard').length, before + 1, 'no resend'); assert.ok(mock.gets >= 1);
    await page.keyboard.press('Escape');
    mock.caps = { version: 1, maxSelection: 50, clipboard: { available: false, code: 'LOCAL_SESSION_REQUIRED', reason: '只能在运行拾光的这台 Mac 上使用。' }, revealMany: { available: false, reason: '只能在运行拾光的这台 Mac 上使用。' } };
    await page.reload(); await expect(work()).toBeVisible(); await selectProjectInBar(page, project.id); await expect(wrap('阿青')).toBeVisible();
    await wrap('阿青').locator('.ca-card').click({ modifiers: ['Meta'] }); await wrap('小满').locator('.ca-card').click({ modifiers: ['Meta'] });
    const gbar = work().getByRole('toolbar', { name: '已选人物操作' });
    await expect(gbar.getByRole('button', { name: '复制' })).toBeDisabled(); await expect(gbar).toContainText('只能在运行拾光的这台 Mac 上使用');
    await page.keyboard.press('Escape');
    const n = posts('clipboard').length;
    const singleRefused = async reason => {
      await wrap('阿青').hover(); await wrap('阿青').getByRole('button', { name: '复制阿青的默认图' }).click();
      await expect(page.getByText('没有复制「阿青」的默认图：' + reason).first()).toBeVisible();
      await wrap('阿青').click({ button: 'right' }); await page.getByRole('menu', { name: '阿青的操作' }).getByRole('menuitem', { name: '复制默认图' }).click();
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect(page.getByText(/已复制「阿青」|已复制 \d+ 张/)).toHaveCount(0);
      assert.equal(posts('clipboard').length, n, 'no file clipboard request'); assert.equal(await page.evaluate(() => window.__clipWrites), 0, 'no browser clipboard.write');
    };
    await singleRefused('只能在运行拾光的这台 Mac 上使用。');
    // 能力还没读到（读取失败）：同样说明原因，不退回 PNG。
    mock.caps = null; await page.unroute('**/api/project-assets/projects/*/desktop-capabilities');
    await page.route('**/api/project-assets/projects/*/desktop-capabilities', route => mock.caps ? route.fulfill({ json: mock.caps }) : route.fulfill({ status: 500, json: { error: '读取失败' } }));
    await page.reload(); await expect(work()).toBeVisible(); await selectProjectInBar(page, project.id); await expect(wrap('阿青')).toBeVisible();
    await singleRefused('后台尚未提供图片文件复制，或正在检查本机桌面能力。');
  });

  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-3000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'creative-multicopy-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); await exited; await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
