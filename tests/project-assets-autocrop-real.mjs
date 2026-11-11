// 自动框到头部的前后端联调：真实服务 + 真实 head-box 路由、裁切来源记录与换默认图时的自动框，
// 只把最底层的原生助手换成替身（tests/helpers/asset-desktop-native-stub.mjs：宽度为偶数的合成图有一张正脸，
// 奇数没有脸），识别结果的挑选与裁切换算走真实后端逻辑。合成图片、临时数据目录；不调用真实 Vision。
// 需要先 npm run build。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';

const root = path.resolve(import.meta.dirname, '..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'creative-autocrop-real-'))), images = path.join(temp, '合成照片'); await fs.mkdir(images);
const ffmpeg = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
// 替身按宽度奇偶决定有没有脸，所以固定 RGB（不做色度抽样，否则奇数宽会被补成偶数），并直接校验生成宽度。
for (const [name, color, w] of [['无脸.png', 'gray', 601], ['正脸.png', 'red', 600], ['侧身.png', 'blue', 602], ['背影.png', 'green', 603], ['近景.png', 'yellow', 604]]) {
  const file = path.join(images, name);
  const run = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${w}x800,format=rgb24`, '-frames:v', '1', file]);
  assert.equal(run.status, 0, run.stderr?.toString());
  assert.equal((await fs.readFile(file)).readUInt32BE(16), w, name + ' keeps its width');
}
const nativeLog = path.join(temp, 'native.jsonl'); await fs.writeFile(nativeLog, '');
const stub = path.join(root, 'tests/helpers/asset-desktop-native-stub.mjs');
const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r)); const port = socket.address().port; await new Promise(r => socket.close(r)); const origin = 'http://127.0.0.1:' + port;
let logs = '', browser, page, cookie, token, passed = false; const checks = [], errors = [], headRequests = [], assetPuts = [];
const child = spawn(process.execPath, ['--import', stub, 'server/index.mjs'], { cwd: root, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', MEDIA_DATA_DIR: path.join(temp, 'data'), MEDIA_PERSONAL_ITEM_DIR: path.join(temp, 'personal_item'), MEDIA_SKIP_IMPORT: '1', MEDIA_SKIP_RECONCILE: '1', MEDIA_NO_WATCH: '1', MEDIA_CODEX_AUTOCONNECT: '0', SHIGUANG_AUDIO_ANALYSIS: '0', ASSET_NATIVE_LOG: nativeLog }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b); const exited = new Promise(r => child.once('exit', r));
async function api(p, body, method) { const response = await fetch(origin + '/api' + p, { method: method ?? (body ? 'POST' : 'GET'), headers: { cookie, origin, 'x-local-token': token, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); assert.ok(response.ok, p + ' ' + JSON.stringify(data)); return data; }
async function check(name, fn) { await fn(); checks.push(name); console.log('PASS ' + name); }
const work = () => page.getByRole('region', { name: '项目资产库' });
const wrap = name => work().locator('.ca-card-wrap').filter({ has: page.locator('strong', { hasText: new RegExp('^' + name + '$') }) });
const undoToast = () => page.locator('.ca-undo-toast');
const asset = id => api('/project-assets/assets/' + id);
const image = async (a, id) => (await asset(a.id)).images.find(b => b.id === id);
const DEFAULT = { x: 50, y: 50, zoom: 1 };
const idle = () => expect(page.locator('.ca-workspace')).not.toHaveAttribute('aria-busy', 'true');
const openCrop = async name => { await wrap(name).click({ button: 'right' }); await page.getByRole('menuitem', { name: '调整头像…' }).click(); const panel = page.getByRole('dialog', { name: '调整' + name + '的头像' }); await expect(panel).toContainText('列表里会这样显示'); return panel; };
const reopen = async project => { await page.reload(); await expect(work()).toBeVisible(); await page.getByLabel('资产所属项目').selectOption(project.id); await expect(wrap('阿青')).toBeVisible(); };

try {
  await expect.poll(() => logs, { timeout: 25000 }).toContain(origin);
  const sessionResponse = await fetch(origin + '/api/session'), session = await sessionResponse.json(); cookie = sessionResponse.headers.get('set-cookie').split(';')[0]; token = session.token;
  const project = await api('/projects', { name: '自动框联调' });
  await api('/roots', { path: images, kind: 'photo' }); await expect.poll(async () => (await api('/jobs')).jobs.every(j => j.status !== 'running'), { timeout: 20000 }).toBe(true);
  const listed = await api('/assets?kind=photo'), media = Object.fromEntries((listed.assets ?? listed.items).map(m => [m.name, m]));
  const bind = (id, look, file) => ({ id, look_id: look, media_asset_id: media[file].id, reference_type: '人物身份', purpose: '', locks: '', ignores: '', confirmed: true, archived_at: null, crop: { ...DEFAULT }, last_known_name: file });
  const make = async (name, files) => {
    let a = await api('/project-assets/assets', { project_id: project.id, kind: 'character', name });
    const look = crypto.randomUUID(), ids = files.map(() => crypto.randomUUID());
    a = await api('/project-assets/assets/' + a.id, { asset: { ...a, default_look_id: look, looks: [{ id: look, name: '常服', description: '', tags: [], default_image_id: ids[0], archived_at: null }],
      images: files.map((f, i) => bind(ids[i], look, f)) }, expected_revision: a.revision }, 'PUT');
    return { a, ids };
  };
  // 第一张作默认：无脸图首次成为默认时后端认不出，保持 untouched。
  const hero = await make('阿青', ['无脸.png', '正脸.png', '侧身.png']), second = await make('小满', ['背影.png']);
  assert.equal((await image(hero.a, hero.ids[0])).crop_source, 'untouched'); assert.deepEqual((await image(hero.a, hero.ids[0])).crop, DEFAULT);
  const suggested = (await api('/project-assets/bindings/' + hero.ids[1] + '/head-box')); assert.equal(suggested.status, 'found', JSON.stringify(suggested));

  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); await context.addInitScript(() => localStorage.setItem('shiguang.refreshSeconds', '0'));
  page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (r.url().includes('/head-box')) headRequests.push(r.url()); if (r.method() === 'PUT' && /\/api\/project-assets\/assets\/[^/]+$/.test(new URL(r.url()).pathname)) assetPuts.push(r.url()); });
  await page.goto(origin + '/#/project-assets'); await expect(work()).toBeVisible(); await page.getByLabel('资产所属项目').selectOption(project.id); await expect(wrap('阿青')).toBeVisible();

  await check('换默认图：首次成为默认、没调整过的正脸图在同一次保存里自动框头部；提示说明；撤销恢复默认图、裁切和来源', async () => {
    await wrap('阿青').click({ button: 'right' }); await page.getByRole('menuitem', { name: '换默认图…' }).click();
    await page.getByRole('button', { name: '设为默认：正脸.png' }).click();
    await expect(undoToast()).toContainText('已把「阿青」的默认图换成「正脸.png」，头像已自动框到头部');
    let b = await image(hero.a, hero.ids[1]); assert.equal(b.crop_source, 'auto'); assert.deepEqual(b.crop, suggested.crop); assert.equal(b.was_card_default, true);
    await undoToast().getByRole('button', { name: '撤销' }).click(); await idle();
    await expect.poll(async () => (await asset(hero.a.id)).looks[0].default_image_id).toBe(hero.ids[0]);
    b = await image(hero.a, hero.ids[1]); assert.deepEqual(b.crop, DEFAULT); assert.equal(b.crop_source, 'untouched'); assert.equal(b.was_card_default, true, 'first-default history is not undone');
  });

  await check('再设为默认不会重复自动框（曾是默认）；打开「调整头像」时没调整过才请求建议，点完成保存为 auto', async () => {
    const a = await asset(hero.a.id); a.looks[0].default_image_id = hero.ids[1]; await api('/project-assets/assets/' + a.id, { asset: a, expected_revision: a.revision }, 'PUT');
    assert.deepEqual((await image(hero.a, hero.ids[1])).crop, DEFAULT, 'was_card_default: no second automatic crop');
    await reopen(project); headRequests.length = 0;
    const panel = await openCrop('阿青'); await expect(panel.getByRole('status')).toHaveText('已自动框到头部，可以再拖');
    assert.equal(headRequests.length, 1); assert.match(headRequests[0], new RegExp(hero.ids[1] + '/head-box\\?bindingRevision=\\d+$'));
    assert.deepEqual((await image(hero.a, hero.ids[1])).crop, DEFAULT, 'suggestion only');
    await panel.getByRole('button', { name: '完成' }).click(); await expect(undoToast()).toContainText('已更新「阿青」的头像'); await idle();
    const b = await image(hero.a, hero.ids[1]); assert.deepEqual(b.crop, suggested.crop); assert.equal(b.crop_source, 'auto');
  });

  await check('拖过以后记为人工：再次打开不自动请求、不显示提示；「重新框到头部」仍可手动用', async () => {
    let panel = await openCrop('阿青'); await panel.locator('.ca-quick-cropbox [tabindex]').first().focus(); await page.keyboard.press('ArrowDown');
    await panel.getByRole('button', { name: '完成' }).click(); await expect(undoToast()).toContainText('已更新「阿青」的头像'); await idle();
    let b = await image(hero.a, hero.ids[1]); assert.equal(b.crop_source, 'manual'); assert.notDeepEqual(b.crop, suggested.crop);
    await reopen(project); headRequests.length = 0;
    panel = await openCrop('阿青'); await page.waitForTimeout(400);
    assert.equal(headRequests.length, 0, 'manual crop never auto-requests'); await expect(panel.getByRole('status')).toHaveCount(0);
    await panel.getByRole('button', { name: '重新框到头部' }).click(); await expect(panel.getByRole('status')).toHaveText('已自动框到头部，可以再拖');
    await panel.getByRole('button', { name: '取消' }).click();
    b = await image(hero.a, hero.ids[1]); assert.equal(b.crop_source, 'manual', 'cancel saves nothing');
  });

  await check('R1 人工历史：调过的图被还原成默认框和 untouched 后，打开不自动请求；显式「重新框到头部」仍可用，保存后人工历史保留', async () => {
    const a = await asset(hero.a.id), b = a.images.find(i => i.id === hero.ids[1]); assert.equal(b.crop_source, 'manual');
    b.crop = { ...DEFAULT }; b.crop_source = 'untouched'; await api('/project-assets/assets/' + a.id, { asset: a, expected_revision: a.revision }, 'PUT');
    let back = await image(hero.a, hero.ids[1]); assert.equal(back.crop_source, 'untouched'); assert.equal(back.crop_manually_edited, true); assert.deepEqual(back.crop, DEFAULT);
    await reopen(project); headRequests.length = 0;
    const panel = await openCrop('阿青'); await page.waitForTimeout(400);
    assert.equal(headRequests.length, 0, 'manual history never auto-requests'); await expect(panel.getByRole('status')).toHaveCount(0);
    await panel.getByRole('button', { name: '重新框到头部' }).click(); await expect(panel.getByRole('status')).toHaveText('已自动框到头部，可以再拖'); assert.equal(headRequests.length, 1);
    await panel.getByRole('button', { name: '完成' }).click(); await expect(undoToast()).toContainText('已更新「阿青」的头像'); await idle();
    back = await image(hero.a, hero.ids[1]); assert.equal(back.crop_source, 'auto'); assert.deepEqual(back.crop, suggested.crop); assert.equal(back.crop_manually_edited, true, 'manual history kept');
  });

  await check('R2 保存前核对：面板打开期间别处换了图或改了裁切，点「完成」不写入、说明要重新打开，对方的裁切保持', async () => {
    const third = await make('阿禾', ['近景.png']); await reopen(project); await expect(wrap('阿禾')).toBeVisible();
    const MANUAL = { x: 27, y: 34, zoom: 1.6 };
    const elsewhere = {
      换图: x => { const b = x.images.find(i => i.id === third.ids[0]); b.media_asset_id = media['侧身.png'].id; b.last_known_name = '侧身.png'; delete b.expected_sha256; b.crop = { ...MANUAL }; b.crop_source = 'manual'; },
      改裁切: x => { const b = x.images.find(i => i.id === third.ids[0]); b.crop = { x: 10, y: 20, zoom: 1.2 }; b.crop_source = 'manual'; },
    };
    for (const [label, change] of Object.entries(elsewhere)) {
      const panel = await openCrop('阿禾');
      await panel.getByRole('button', { name: '重新框到头部' }).click(); await expect(panel.getByRole('status')).toHaveText('已自动框到头部，可以再拖');
      const a = await asset(third.a.id); change(a); await api('/project-assets/assets/' + a.id, { asset: a, expected_revision: a.revision }, 'PUT');
      const theirs = await image(third.a, third.ids[0]); assert.equal(theirs.crop_source, 'manual', label);
      const puts = assetPuts.length;
      await panel.getByRole('button', { name: '完成' }).click();
      await expect(page.getByText('「阿禾」的默认图或头像刚在别处改过，没有覆盖。请重新打开「调整头像」').first()).toBeVisible(); await idle();
      assert.equal(assetPuts.length, puts, label + ': nothing written');
      const after = await image(third.a, third.ids[0]); assert.deepEqual(after.crop, theirs.crop, label); assert.equal(after.crop_source, 'manual', label); assert.equal(after.media_asset_id, theirs.media_asset_id, label);
      await expect(undoToast()).toHaveCount(0);
      // 按提示直接重新打开（不整页刷新）：面板是最新的图和框，「重新框到头部」不会拿到过期版本。
      const again = await openCrop('阿禾'); await expect(again.locator('header small')).toHaveText(after.last_known_name);
      await again.getByRole('button', { name: '重新框到头部' }).click(); await expect(again.getByRole('status')).toHaveText('已自动框到头部，可以再拖');
      await again.getByRole('button', { name: '取消' }).click();
    }
  });

  await check('R3 面板打开期间别处拖过又撤销：框和来源回到原值但留下人工历史，点「完成」也不写入', async () => {
    const fourth = await make('阿芷', ['无脸.png', '近景.png']);
    const put = async fn => { const x = await asset(fourth.a.id); fn(x); return api('/project-assets/assets/' + x.id, { asset: x, expected_revision: x.revision }, 'PUT'); };
    const img = x => x.images.find(i => i.id === fourth.ids[1]);
    // 近景首次成为默认被自动框，再还原成默认框和 untouched：没有人工历史。
    await put(x => { x.looks[0].default_image_id = fourth.ids[1]; });
    await put(x => { img(x).crop = { ...DEFAULT }; img(x).crop_source = 'untouched'; });
    let b = await image(fourth.a, fourth.ids[1]); assert.equal(b.crop_source, 'untouched'); assert.equal(b.crop_manually_edited, false); assert.deepEqual(b.crop, DEFAULT);
    await reopen(project); await expect(wrap('阿芷')).toBeVisible();
    const panel = await openCrop('阿芷'); await expect(panel.getByRole('status')).toHaveText('已自动框到头部，可以再拖');
    await put(x => { img(x).crop = { x: 20, y: 20, zoom: 1.5 }; });
    await put(x => { img(x).crop = { ...DEFAULT }; img(x).crop_source = 'untouched'; });
    b = await image(fourth.a, fourth.ids[1]); assert.equal(b.crop_source, 'untouched'); assert.deepEqual(b.crop, DEFAULT); assert.equal(b.crop_manually_edited, true);
    const puts = assetPuts.length;
    await panel.getByRole('button', { name: '完成' }).click();
    await expect(page.getByText('「阿芷」的默认图或头像刚在别处改过，没有覆盖。请重新打开「调整头像」').first()).toBeVisible(); await idle();
    assert.equal(assetPuts.length, puts, 'nothing written');
    b = await image(fourth.a, fourth.ids[1]); assert.deepEqual(b.crop, DEFAULT); assert.equal(b.crop_source, 'untouched');
    // 重新打开：有人工历史，不自动请求；显式重新框仍可用。
    headRequests.length = 0; const again = await openCrop('阿芷'); await page.waitForTimeout(400);
    assert.equal(headRequests.length, 0); await again.getByRole('button', { name: '重新框到头部' }).click(); await expect(again.getByRole('status')).toHaveText('已自动框到头部，可以再拖');
    await again.getByRole('button', { name: '取消' }).click();
  });

  await check('认不出头部：框保持原样并说明，「重新框到头部」停用', async () => {
    // 小满的唯一图片创建时认不出，仍是没调整过的默认图。
    assert.equal((await image(second.a, second.ids[0])).crop_source, 'untouched');
    const panel = await openCrop('小满'); await expect(panel.getByRole('status')).toHaveText('没认出头部，请自己拖动框');
    await expect(panel.getByRole('button', { name: '重新框到头部' })).toBeDisabled();
    await panel.getByRole('button', { name: '取消' }).click(); assert.deepEqual((await image(second.a, second.ids[0])).crop, DEFAULT);
  });

  await check('详情图片设置：点「重新框到头部」只改草稿，保存后记为 auto；后端算出的裁切与预览一致', async () => {
    await wrap('阿青').click(); await expect(work().getByLabel('基础信息', { exact: true })).toBeVisible();
    await work().locator('.ca-tile').filter({ hasText: '侧身.png' }).locator('.ca-tile-open').click();
    const dialog = page.getByRole('dialog', { name: '参考图片设置：侧身.png' }); await dialog.locator('summary', { hasText: '封面裁切与库内使用' }).click();
    await dialog.getByRole('button', { name: '重新框到头部' }).click(); await expect(dialog.getByRole('status')).toHaveText('已框到头部，可以再拖；点下方「保存」后生效');
    assert.deepEqual((await image(hero.a, hero.ids[2])).crop, DEFAULT, 'not saved yet');
    const expectZoom = (await api('/project-assets/bindings/' + hero.ids[2] + '/head-box')).crop.zoom;
    await expect(dialog.getByLabel('裁切zoom')).toHaveValue(String(expectZoom));
    await dialog.getByLabel('关闭图片设置').click();
    await work().getByRole('button', { name: '保存资料', exact: true }).click(); await expect(page.getByText(/已保存 · V/).first()).toBeVisible();
    const b = await image(hero.a, hero.ids[2]); assert.equal(b.crop_source, 'auto'); assert.equal(b.crop.zoom, expectZoom);
  });

  const detects = (await fs.readFile(nativeLog, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.op === 'detect-face');
  assert.ok(detects.length >= 3, 'native detect-face reached through the real backend');
  assert.deepEqual(errors, [], '页面不应出现脚本错误');
  passed = true;
} finally {
  if (!passed) { console.error(logs.slice(-3000)); if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'creative-autocrop-real-failure.png') }).catch(() => {}); }
  await browser?.close(); child.kill('SIGTERM'); await exited; await fs.rm(temp, { recursive: true, force: true });
  console.log(`${checks.length} 项${passed ? '全部通过' : '未全部通过'}`);
}
if (!passed) process.exit(1);
