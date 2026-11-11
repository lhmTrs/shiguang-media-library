// 项目资产「自动框到头部」的界面检查（只做写实）。
// 后端自动框（feat/codex-assets-autocrop）未合入前，按已确认合同用 page.route 模拟：
// - GET /bindings/:id/head-box → {status, bindingId, bindingRevision, crop}
// - images[].crop_source（null / untouched / manual / auto）：现有服务会丢弃这个字段，所以在资产读取回应里按记录补上，
//   在资产保存请求里记下前端提交的值；换默认图时模拟后端在同一次保存里自动框头部。
// 其余走真实本地服务和合成图片；不触碰真实素材库。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'creative-autocrop-')), images = path.join(temp, '合成照片'); await fs.mkdir(images);
const ffmpeg = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
for (const [name, color] of [['正面.png', 'red'], ['侧面.png', 'blue'], ['日常.png', 'green']]) {
  const run = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=600x800`, '-frames:v', '1', path.join(images, name)]);
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
const undoToast = () => page.locator('.ca-undo-toast');
const asset = id => api('/project-assets/assets/' + id);
const shot = async name => { if (process.env.AUTOCROP_SHOTS) await page.screenshot({ path: path.join(process.env.AUTOCROP_SHOTS, name + '.png') }); };
const SUGGEST = { x: 50, y: 12, zoom: 2.2 };
// 模拟后端：每张绑定的裁切来源、每张的 head-box 结果、换默认图时是否自动框。
const mock = { source: new Map(), head: new Map(), wasDefault: new Set(), delay: 0, calls: [], puts: [] };
const inject = value => { if (Array.isArray(value)) value.forEach(inject); else if (value && typeof value === 'object') { if (Array.isArray(value.images)) value.images.forEach(b => { if (b && b.id) b.crop_source = mock.source.has(b.id) ? mock.source.get(b.id) : null; }); Object.values(value).forEach(inject); } };
async function installMocks() {
  await page.route('**/api/project-assets/bindings/*/head-box*', async route => {
    const id = decodeURIComponent(route.request().url().split('/').at(-2)); mock.calls.push(id);
    const kind = mock.head.get(id) ?? 'found'; if (mock.delay) await new Promise(r => setTimeout(r, mock.delay));
    if (kind === 'stale') return route.fulfill({ status: 409, json: { error: '图片绑定已变化，请重新读取', code: 'IMAGE_BINDING_STALE' } });
    await route.fulfill({ json: kind === 'found' ? { status: 'found', bindingId: id, crop: SUGGEST } : { status: kind, bindingId: id } });
  });
  await page.route(url => url.pathname.startsWith('/api/project-assets/assets'), async route => {
    const req = route.request(), method = req.method();
    if (method === 'PUT') {
      const body = req.postDataJSON(); mock.puts.push(structuredClone(body));
      const before = await asset(body.asset.id), auto = [];
      // 首次成为卡片默认、从未调整过（untouched）的图，后端在同一次保存里自动框头部。
      for (const l of body.asset.looks || []) {
        const was = before.looks.find(x => x.id === l.id)?.default_image_id;
        if (l.default_image_id && l.default_image_id !== was && !mock.wasDefault.has(l.default_image_id) && mock.source.get(l.default_image_id) === 'untouched') { const b = body.asset.images.find(i => i.id === l.default_image_id); if (b) { b.crop = SUGGEST; b.crop_source = 'auto'; auto.push(b.id); } }
      }
      for (const b of body.asset.images || []) if ('crop_source' in b) mock.source.set(b.id, b.crop_source);
      for (const l of body.asset.looks || []) if (l.default_image_id) mock.wasDefault.add(l.default_image_id);
      const response = await route.fetch({ postData: JSON.stringify(body) }), json = await response.json(); if (response.ok()) inject(json);
      return route.fulfill({ response, json });
    }
    if (method !== 'GET') return route.continue();
    const response = await route.fetch(); const json = await response.json(); inject(json); await route.fulfill({ response, json });
  });
}
const openCrop = async name => { await wrap(name).click({ button: 'right' }); await page.getByRole('menuitem', { name: '调整头像…' }).click(); const panel = page.getByRole('dialog', { name: '调整' + name + '的头像' }); await expect(panel).toContainText('列表里会这样显示'); return panel; };
const lastPut = () => mock.puts.at(-1).asset;
// 点撤销并等到真正发出撤销保存、提示出现（避免把上一次的「已撤销」当成这一次）。
const undoNow = async () => { const n = mock.puts.length; await undoToast().getByRole('button', { name: '撤销' }).click(); await expect.poll(() => mock.puts.length).toBe(n + 1); await expect(page.locator('.ca-workspace')).not.toHaveAttribute('aria-busy', 'true'); };
const reset = async (a, id, source) => { const x = await asset(a.id); x.images.find(b => b.id === id).crop = { x: 50, y: 50, zoom: 1 }; await api('/project-assets/assets/' + a.id, { asset: x, expected_revision: x.revision }, 'PUT'); mock.source.set(id, source); };

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  const project = await api('/projects', { name: '自动框短片' });
  await api('/roots', { path: images, kind: 'photo' }); await expect.poll(async () => (await api('/jobs')).jobs.every(j => j.status !== 'running'), { timeout: 20000 }).toBe(true);
  const listed = await api('/assets?kind=photo'), media = Object.fromEntries((listed.assets ?? listed.items).map(m => [m.name, m]));
  const bind = (id, look, file) => ({ id, look_id: look, media_asset_id: media[file].id, reference_type: '人物身份', purpose: '', locks: '', ignores: '', confirmed: true, archived_at: null, crop: { x: 50, y: 50, zoom: 1 }, last_known_name: file });
  const make = async name => {
    let a = await api('/project-assets/assets', { project_id: project.id, kind: 'character', name });
    const look = crypto.randomUUID(), ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    a = await api('/project-assets/assets/' + a.id, { asset: { ...a, default_look_id: look, looks: [{ id: look, name: '常服', description: '', tags: [], default_image_id: ids[0], archived_at: null }],
      images: ['正面.png', '侧面.png', '日常.png'].map((f, i) => bind(ids[i], look, f)) }, expected_revision: a.revision }, 'PUT');
    return { a, ids };
  };
  const hero = await make('阿青'), second = await make('小满');
  for (const id of [...hero.ids, ...second.ids]) mock.source.set(id, 'untouched');
  mock.wasDefault.add(hero.ids[0]).add(second.ids[0]);

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await installMocks();
  await page.goto(origin + '/#/project-assets'); await expect(work()).toBeVisible(); await page.getByLabel('资产所属项目').selectOption(project.id); await expect(wrap('阿青')).toBeVisible();

  await check('没调整过的默认图：打开「调整头像」自动框到头部，只是建议；点完成才保存为 auto，撤销连来源一起恢复', async () => {
    const panel = await openCrop('阿青');
    await expect(panel.getByRole('status')).toHaveText('已自动框到头部，可以再拖'); await shot('1-found');
    assert.deepEqual(mock.calls, [hero.ids[0]]);
    assert.deepEqual((await asset(hero.a.id)).images.find(b => b.id === hero.ids[0]).crop, { x: 50, y: 50, zoom: 1 }, 'nothing saved before 完成');
    await panel.getByRole('button', { name: '完成' }).click(); await expect(undoToast()).toContainText('已更新「阿青」的头像');
    const sent = lastPut().images.find(b => b.id === hero.ids[0]); assert.deepEqual(sent.crop, SUGGEST); assert.equal(sent.crop_source, 'auto');
    assert.deepEqual((await asset(hero.a.id)).images.find(b => b.id === hero.ids[0]).crop, SUGGEST);
    await undoNow();
    const undone = lastPut().images.find(b => b.id === hero.ids[0]); assert.deepEqual(undone.crop, { x: 50, y: 50, zoom: 1 }); assert.equal(undone.crop_source, 'untouched');
  });

  await check('调过的裁切和旧记录不自动框；点「重新框到头部」才请求，用户拖动后提交 manual', async () => {
    for (const source of ['manual', null]) {
      mock.source.set(hero.ids[0], source); mock.calls.length = 0;
      await page.reload(); await page.getByLabel('资产所属项目').selectOption(project.id); await expect(wrap('阿青')).toBeVisible();
      const panel = await openCrop('阿青'); await page.waitForTimeout(300);
      assert.deepEqual(mock.calls, [], 'no automatic request for ' + source); await expect(panel.getByRole('status')).toHaveCount(0);
      await panel.getByRole('button', { name: '重新框到头部' }).click(); await expect(panel.getByRole('status')).toHaveText('已自动框到头部，可以再拖');
      assert.equal(mock.calls.length, 1);
      await panel.locator('.ca-quick-cropbox [tabindex]').first().focus(); await page.keyboard.press('ArrowDown');
      await expect(panel.getByRole('status')).toHaveCount(0);
      await panel.getByRole('button', { name: '完成' }).click(); await expect(undoToast()).toContainText('已更新「阿青」的头像');
      const sent = lastPut().images.find(b => b.id === hero.ids[0]); assert.equal(sent.crop_source, 'manual'); assert.notDeepEqual(sent.crop, SUGGEST);
      await undoNow();
    }
  });

  await check('识别结果晚于用户拖动返回：直接丢弃，不改框', async () => {
    await reset(hero.a, hero.ids[0], 'untouched'); await page.reload(); await page.getByLabel('资产所属项目').selectOption(project.id); await expect(wrap('阿青')).toBeVisible();
    mock.delay = 1500; mock.calls.length = 0;
    const panel = await openCrop('阿青'); await expect(panel.getByRole('status')).toHaveText('正在找头部…');
    await panel.locator('.ca-quick-cropbox [tabindex]').first().focus(); await page.keyboard.press('ArrowUp');
    await expect(panel.getByRole('status')).toHaveCount(0);
    await page.waitForTimeout(1900); assert.equal(mock.calls.length, 1);
    await expect(panel.getByRole('status')).toHaveCount(0);
    await panel.getByRole('button', { name: '完成' }).click(); await expect(undoToast()).toContainText('已更新「阿青」的头像');
    const sent = lastPut().images.find(b => b.id === hero.ids[0]); assert.equal(sent.crop_source, 'manual'); assert.notDeepEqual(sent.crop, SUGGEST);
    mock.delay = 0; await undoNow();
  });

  await check('认不出 / 不支持 / 图已变化：框保持原样并说明，「重新框到头部」停用；取消不保存', async () => {
    for (const [kind, text] of [['not_found', '没认出头部，请自己拖动框'], ['unsupported', '这张图暂不支持自动框（目前只认写实照片），请自己拖动框'], ['stale', '这张图刚在别处改过，请关掉面板重新打开']]) {
      mock.head.set(second.ids[0], kind); const puts = mock.puts.length;
      const panel = await openCrop('小满'); await expect(panel.getByRole('status')).toHaveText(text);
      await expect(panel.getByRole('button', { name: '重新框到头部' })).toBeDisabled(); if (kind === 'not_found') await shot('2-miss');
      await panel.getByRole('button', { name: '取消' }).click(); assert.equal(mock.puts.length, puts);
    }
    mock.head.set(second.ids[0], 'busy');
    const panel = await openCrop('小满'); await expect(panel.getByRole('status')).toHaveText('识别正忙，稍后再点「重新框到头部」');
    await expect(panel.getByRole('button', { name: '重新框到头部' })).toBeEnabled();
    mock.head.delete(second.ids[0]); await panel.getByRole('button', { name: '重新框到头部' }).click(); await expect(panel.getByRole('status')).toHaveText('已自动框到头部，可以再拖');
    await panel.getByRole('button', { name: '取消' }).click();
  });

  await check('换默认图：后端在同一次保存里自动框头部，提示说明；撤销把默认图、裁切和来源一起恢复', async () => {
    await wrap('小满').click({ button: 'right' }); await page.getByRole('menuitem', { name: '换默认图…' }).click();
    await page.getByRole('button', { name: '设为默认：侧面.png' }).click();
    await expect(undoToast()).toContainText('已把「小满」的默认图换成「侧面.png」，头像已自动框到头部');
    let saved = await asset(second.a.id); assert.equal(saved.looks[0].default_image_id, second.ids[1]); assert.deepEqual(saved.images.find(b => b.id === second.ids[1]).crop, SUGGEST);
    await undoNow();
    saved = await asset(second.a.id); assert.equal(saved.looks[0].default_image_id, second.ids[0]); assert.deepEqual(saved.images.find(b => b.id === second.ids[1]).crop, { x: 50, y: 50, zoom: 1 });
    assert.equal(lastPut().images.find(b => b.id === second.ids[1]).crop_source, 'untouched');
  });

  await check('详情图片设置：打开不自动改草稿；点「重新框到头部」改草稿（auto），拉滑块记为 manual，点保存才写入', async () => {
    await wrap('阿青').click(); await expect(work().getByLabel('基础信息', { exact: true })).toBeVisible();
    mock.calls.length = 0; const puts = mock.puts.length;
    await work().locator('.ca-tile').filter({ hasText: '侧面.png' }).locator('.ca-tile-open').click();
    const dialog = page.getByRole('dialog', { name: '参考图片设置：侧面.png' }); await expect(dialog).toBeVisible();
    await page.waitForTimeout(300); assert.deepEqual(mock.calls, [], 'opening image settings never auto-requests');
    await dialog.locator('summary', { hasText: '封面裁切与库内使用' }).click();
    await dialog.getByRole('button', { name: '重新框到头部' }).click();
    await expect(dialog.getByRole('status')).toHaveText('已框到头部，可以再拖；点下方「保存」后生效'); await shot('3-detail');
    assert.equal(mock.puts.length, puts, 'not saved yet');
    await dialog.getByLabel('关闭图片设置').click();
    await work().getByRole('button', { name: '保存资料', exact: true }).click(); await expect(page.getByText(/已保存 · V/).first()).toBeVisible();
    let sent = lastPut().images.find(b => b.id === hero.ids[1]); assert.deepEqual(sent.crop, SUGGEST); assert.equal(sent.crop_source, 'auto');
    await work().locator('.ca-tile').filter({ hasText: '侧面.png' }).locator('.ca-tile-open').click();
    await dialog.locator('summary', { hasText: '封面裁切与库内使用' }).click();
    await dialog.getByLabel('裁切zoom').fill('1.5'); await expect(dialog.getByRole('status')).toHaveCount(0);
    await dialog.getByLabel('关闭图片设置').click();
    await work().getByRole('button', { name: '保存资料', exact: true }).click(); await expect.poll(() => lastPut().images.find(b => b.id === hero.ids[1]).crop.zoom).toBe(1.5);
    sent = lastPut().images.find(b => b.id === hero.ids[1]); assert.equal(sent.crop_source, 'manual');
  });

  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-3000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'creative-autocrop-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); await exited; await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
